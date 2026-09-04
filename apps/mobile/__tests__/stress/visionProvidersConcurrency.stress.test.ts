/**
 * STRESS — apps/mobile/src/vision/providers.ts under the CONCURRENCY lens.
 *
 * The module is the ONLY place the app maps registry entries to concrete
 * provider instances (`createFusionProviders`, `selectVisionProviders`) and
 * hosts the AUTO DETECT classifier adapter. Every capture analysis on the
 * device goes through it, and several can be in flight at once (a burst of
 * session events, an Analyze run racing a retry, a second actor on the same
 * capture). If provider selection or a provider instance carried hidden
 * mutable state, two interleaved analyses could see each other's inputs —
 * a fundamentally incorrect score with no error.
 *
 * The campaign fires seeded `Promise.all` bursts through a deterministic
 * interleaving scheduler (every provider call yields a seeded number of
 * micro/macro-task ticks, so K concurrent analyses interleave differently
 * per seed) and cross-checks EVERY concurrent result against a sequential
 * oracle computed with fresh providers on the same input:
 *
 *   fusion_shared     ONE FusionProviders bundle shared by K analyses
 *                     (duplicate inputs, declared + AUTO DETECT, partial
 *                     paddle tracks, abandoned callers)
 *   fusion_fresh      K analyses each selecting their own bundle while the
 *                     platform flips ios<->android between calls
 *   classifier_burst  K classify() calls incl. throwing/partial inputs via
 *                     Promise.allSettled — one rejection must not poison
 *                     its siblings
 *   legacy_shared     ONE recording -> selectVisionProviders + analyzeClip
 *                     from K callers (plus starved / missing recordings)
 *   clock_skew        K analyses with independent, non-monotonic clocks and
 *                     id factories — no cross-run leakage or lost model runs
 *
 * Invariants per burst: results byte-identical to the oracle, inputs never
 * mutated (hash before/after), fresh instances per selection, registry
 * unchanged, bounded wall time (a hang is a failure, not a skip).
 *
 * Every iteration is replayable from its seed (STRESS_SEEDS=1,2,3); the
 * per-seed table lands in coverage/stress/vision-providers-concurrency.json
 * (git-ignored; STRESS_OUT overrides the directory). STRESS_ITER scales the campaign
 * (the default keeps the suite fast).
 */
import { Platform } from 'react-native';
import type { ShotTypeSlug } from '@pickle/shared-types';
import { SHOT_TYPES } from '@pickle/shared-types';
import {
  analyzeCapture,
  analyzeClip,
  type FusionProviders,
  type IHierarchicalStrokeClassifier,
} from '@pickle/analysis-pipeline';
import {
  measured,
  unavailable,
  type PaddleTrack,
  type PoseSequence,
} from '@pickle/swing-domain';
import {
  generateSwing,
  generateSwingSequence,
  type SwingTruth,
} from '@pickle/evaluation';
import type { RecordedStrokeInput } from '@pickle/vision-geometry';
import type { VisionProviderSet } from '@pickle/vision-contracts';
import {
  createFusionProviders,
  registry,
  scoringStackStatus,
  selectVisionProviders,
} from '../../src/vision/providers';

jest.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'coverage', 'stress');
const ITERATIONS = Math.max(
  1,
  Number.parseInt(process.env.STRESS_ITER ?? '', 10) || 40,
);
const REPLAY_SEEDS = (process.env.STRESS_SEEDS ?? '')
  .split(',')
  .map(s => Number.parseInt(s.trim(), 10))
  .filter(n => Number.isFinite(n));
/** A burst that has not settled by then is a deadlock, not a slow test. */
const BURST_WALL_MS = 20_000;

const mutablePlatform = Platform as unknown as { OS: string };

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ─── Deterministic interleaving scheduler ───────────────────────────────────

/**
 * Every wrapped provider call awaits a seeded number of micro- or macro-task
 * ticks before and after delegating. With K analyses awaiting the same
 * bundle this permutes the stage order across runs deterministically for a
 * seed (Node's microtask and setImmediate queues are FIFO), so a seed is a
 * replayable interleaving. It also records how much real overlap happened.
 */
const liveSchedulers: Scheduler[] = [];

class Scheduler {
  public inFlight = 0;
  public maxInFlight = 0;
  public yields = 0;
  public calls = 0;
  /** Consecutive provider calls that came from DIFFERENT runs. */
  public switches = 0;
  /** Runs that actually reached a provider (synchronous refusals never do). */
  public readonly activeTags = new Set<string>();
  private lastTag: string | null = null;

  public constructor(private readonly rng: Rng) {
    liveSchedulers.push(this);
  }

  public async yield(): Promise<void> {
    const ticks = int(this.rng, 0, 3);
    for (let i = 0; i < ticks; i += 1) {
      this.yields += 1;
      if (this.rng() < 0.5) {
        await Promise.resolve();
      } else {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
  }

  public wrap<T extends object>(target: T, tag: string): T {
    return new Proxy(target, {
      get: (obj, prop, receiver) => {
        const value = Reflect.get(obj, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await this.yield();
          this.calls += 1;
          if (this.lastTag !== null && this.lastTag !== tag) this.switches += 1;
          this.lastTag = tag;
          this.activeTags.add(tag);
          this.inFlight += 1;
          this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
          try {
            return await (
              value as (...inner: unknown[]) => Promise<unknown>
            ).apply(obj, args);
          } finally {
            this.inFlight -= 1;
            await this.yield();
          }
        };
      },
    });
  }
}

/** Same underlying instances, one run's view of them (tag = the caller). */
function wrapFusion(
  providers: FusionProviders,
  sched: Scheduler,
  tag: string,
): FusionProviders {
  return {
    phase: sched.wrap(providers.phase, tag),
    biomechanics: sched.wrap(providers.biomechanics, tag),
    scorer: sched.wrap(providers.scorer, tag),
    faultDetector: sched.wrap(providers.faultDetector, tag),
    uncertainty: sched.wrap(providers.uncertainty, tag),
    coach: sched.wrap(providers.coach, tag),
    classifier: providers.classifier
      ? sched.wrap(providers.classifier, tag)
      : null,
    autoStrokeClassifier: providers.autoStrokeClassifier
      ? sched.wrap(providers.autoStrokeClassifier, tag)
      : null,
    shadowScorers: providers.shadowScorers.map(s => sched.wrap(s, tag)),
  };
}

function wrapLegacy(
  providers: VisionProviderSet,
  sched: Scheduler,
  tag: string,
): VisionProviderSet {
  return {
    ...providers,
    pose: sched.wrap(providers.pose, tag),
    paddle: sched.wrap(providers.paddle, tag),
    stroke: sched.wrap(providers.stroke, tag),
    phase: sched.wrap(providers.phase, tag),
    features: sched.wrap(providers.features, tag),
    ball: providers.ball ? sched.wrap(providers.ball, tag) : null,
  };
}

/** Strip per-run identity (ids, clock output) so duplicate runs can be compared. */
function identityNeutral(serialized: string): string {
  return serialized
    .replace(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g, '"<iso>"')
    .replace(/"[a-z]+-\d+-\d+"/g, '"<analysis-id>"')
    .replace(/"[a-z]+\d+-id-\d+"/g, '"<id>"');
}

// ─── Stable hashing (input immutability + result equality) ──────────────────

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
    return v;
  });
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
const hashOf = (value: unknown): string => fnv1a(stableStringify(value));

// ─── Seeded swing inputs ────────────────────────────────────────────────────

const TRUTH_POOL: ReadonlyArray<Partial<SwingTruth>> = [
  {},
  { handed: 'left' },
  { kneeFlexionDeg: 5 },
  { kneeFlexionDeg: 55, stanceWidthRatio: 0.9 },
  { contactForwardNorm: -0.2 },
  { contactForwardNorm: 0.9, contactHeightRatio: 0.9 },
  { backswingLengthNorm: 0.1, swingDipNorm: 0 },
  { backswingLengthNorm: 1.6, swingDipNorm: 0.4 },
  { shoulderTurnDeg: 5 },
  { shoulderTurnDeg: 110, handed: 'left' },
  { torsoLength: 0.08 },
  { torsoLength: 0.35 },
  { fps: 24 },
  { fps: 120, accelerateMs: 100 },
  { readyMs: 50, recoverMs: 50 },
];

function seededTruth(rng: Rng): Partial<SwingTruth> {
  const base = pick(rng, TRUTH_POOL);
  return rng() < 0.5
    ? base
    : {
        ...base,
        kneeFlexionDeg: int(rng, 0, 70),
        contactForwardNorm: int(rng, -30, 120) / 100,
        shoulderTurnDeg: int(rng, 0, 120),
      };
}

const DECLARED_POOL: ReadonlyArray<ShotTypeSlug | null> = [
  null,
  null,
  ...SHOT_TYPES,
];

interface FusionCase {
  label: string;
  declared: ShotTypeSlug | null;
  handedness: 'left' | 'right';
  cameraView: 'side' | 'rear_oblique';
  sequence: PoseSequence;
  window: { startMs: number; endMs: number; peakMs: number };
  peakNull: boolean;
  paddle: PaddleTrack | null;
  /** The caller races away from the promise (no cancellation API exists). */
  abandoned: boolean;
}

const PADDLE_MODEL = {
  providerId: 'paddle.stress-synthetic',
  modelVersion: 'stress-1',
  runtime: 'deterministic',
  executionTarget: 'on_device',
  artifactHash: null,
} as const;

/** Partial paddle track: some observations carry no measured center. */
function seededPaddle(rng: Rng, sequence: PoseSequence): PaddleTrack | null {
  const mode = int(rng, 0, 3);
  if (mode === 0) return null;
  const observations = sequence.frames.map((frame, index) => {
    const hasCenter = mode === 1 ? true : mode === 2 ? index % 2 === 0 : false;
    return {
      frameIndex: frame.frameIndex,
      timestampMs: frame.timestampMs,
      bbox: null,
      keypoints: {
        handleEnd: null,
        throat: null,
        center: hasCenter
          ? { x: 0.4 + (index % 7) / 100, y: 0.5 - (index % 5) / 100 }
          : null,
        tip: null,
      },
      confidence: 0.7,
    };
  });
  return {
    schemaVersion: 1,
    coordinateSystem: 'normalized_image_top_left',
    producedBy: { ...PADDLE_MODEL },
    observations,
    continuity: mode === 1 ? 1 : mode === 2 ? 0.5 : 0,
  };
}

function seededFusionCase(rng: Rng, index: number): FusionCase {
  const truth = seededTruth(rng);
  const { sequence, window } = generateSwingSequence(truth);
  return {
    label: `case-${index}`,
    declared: pick(rng, DECLARED_POOL),
    handedness: rng() < 0.5 ? 'left' : 'right',
    cameraView: rng() < 0.8 ? 'side' : 'rear_oblique',
    sequence,
    window,
    peakNull: rng() < 0.15,
    paddle: seededPaddle(rng, sequence),
    abandoned: rng() < 0.1,
  };
}

interface RunClock {
  nowIso: () => string;
  makeId: () => string;
  /** Every value the clock handed out — for leakage checks. */
  issuedTimes: string[];
  issuedIds: string[];
}

/** Deterministic per-run clock; optionally skewed / non-monotonic. */
function makeClock(
  tag: string,
  skew: 'monotonic' | 'backwards' | 'jitter',
  rng: Rng,
): RunClock {
  const base =
    Date.UTC(2026, 8, 4, 12, 0, 0) + int(rng, -86_400_000, 86_400_000);
  let tick = 0;
  let idCounter = 0;
  const issuedTimes: string[] = [];
  const issuedIds: string[] = [];
  return {
    issuedTimes,
    issuedIds,
    nowIso: () => {
      tick += 1;
      const offset =
        skew === 'monotonic'
          ? tick * 7
          : skew === 'backwards'
            ? -tick * 1_000
            : int(rng, -60_000, 60_000);
      const iso = new Date(base + offset).toISOString();
      issuedTimes.push(iso);
      return iso;
    },
    makeId: () => {
      idCounter += 1;
      const id = `${tag}-id-${idCounter}`;
      issuedIds.push(id);
      return id;
    },
  };
}

async function runFusion(
  providers: FusionProviders,
  fusionCase: FusionCase,
  analysisId: string,
  clockTag: string,
  skew: 'monotonic' | 'backwards' | 'jitter',
  clockRng: Rng,
): Promise<{ outcome: unknown; clock: RunClock }> {
  const clock = makeClock(clockTag, skew, clockRng);
  const result = await analyzeCapture(
    providers,
    {
      captureId: `capture-${fusionCase.label}`,
      pose: fusionCase.sequence,
      paddle: fusionCase.paddle
        ? measured(fusionCase.paddle)
        : unavailable('paddle_detector_not_installed'),
      ball: unavailable('ball_tracker_not_installed'),
      trigger: {
        startMs: fusionCase.window.startMs,
        endMs: fusionCase.window.endMs,
        peakMotionMs: fusionCase.peakNull ? null : fusionCase.window.peakMs,
        confidence: 0.86,
        producedBy: {
          providerId: 'trigger.temporal-heuristic',
          modelVersion: 'temporal-stroke-heuristic-2',
          runtime: 'deterministic',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      },
      stroke: { declared: fusionCase.declared, predicted: null },
      handedness: fusionCase.handedness,
      cameraView: fusionCase.cameraView,
      capturedAtIso: '2026-09-04T12:00:00.000Z',
    },
    {
      analysisId,
      sessionId: null,
      appVersion: '0.1.0',
      modelBundleVersion: scoringStackStatus().version,
      nowIso: clock.nowIso,
      makeId: clock.makeId,
    },
  );
  return { outcome: result, clock };
}

// ─── Outcome bookkeeping ────────────────────────────────────────────────────

type Kind =
  | 'fusion_shared'
  | 'fusion_fresh'
  | 'classifier_burst'
  | 'legacy_shared'
  | 'clock_skew';
const KINDS: readonly Kind[] = [
  'fusion_shared',
  'fusion_fresh',
  'classifier_burst',
  'legacy_shared',
  'clock_skew',
];

interface IterationRow {
  seed: number;
  kind: Kind;
  concurrency: number;
  maxInFlight: number;
  switches: number;
  activeRuns: number;
  yields: number;
  providerCalls: number;
  durationMs: number;
  outcome: 'HELD' | 'BROKEN';
  detail: string[];
  /** Result shapes the burst actually exercised, e.g. ok:scored:declared. */
  outcomes: Record<string, number>;
}

type Tally = Record<string, number>;
const tally = (t: Tally, key: string): void => {
  t[key] = (t[key] ?? 0) + 1;
};

function describeOutcome(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value;
  const v = value as Record<string, unknown>;
  if (v.kind === 'unavailable') return 'unavailable';
  if (v.status === 'rejected') return 'rejected';
  if (v.status === 'fulfilled') return `fulfilled:${describeOutcome(v.value)}`;
  if (v.ok === false) {
    const failure = v.failure as Record<string, unknown> | undefined;
    return `fail:${String(failure?.code ?? 'unknown')}`;
  }
  if (v.ok === true) {
    const inner = v.value as Record<string, unknown>;
    const result = inner.result as Record<string, unknown> | null | undefined;
    const resolution = inner.strokeResolution as
      Record<string, unknown> | undefined;
    if (typeof inner.label === 'string')
      return `ok:label=${inner.label}:depth${String(inner.taxonomyDepth)}`;
    if (typeof inner.resultKind === 'string') return `ok:${inner.resultKind}`;
    if (result === null) return `ok:unresolved:${String(resolution?.kind)}`;
    if (result && typeof result.resultKind === 'string') {
      return `ok:${result.resultKind}${resolution ? `:${String(resolution.kind)}` : ''}`;
    }
    return 'ok';
  }
  return 'unknown-shape';
}

const rows: IterationRow[] = [];
let scenariosExecuted = 0;

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label}: burst did not settle within ${BURST_WALL_MS}ms (deadlock?)`,
          ),
        ),
      BURST_WALL_MS,
    );
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ─── Burst kinds ────────────────────────────────────────────────────────────

function realFusion(declared: ShotTypeSlug | null): FusionProviders {
  const selection = createFusionProviders(declared);
  if (selection.kind !== 'real') {
    throw new Error(
      `fusion providers unavailable for ${String(declared)}: ${selection.reason}`,
    );
  }
  return selection.providers;
}

/** Sequential oracle: fresh providers, same input, same clock parameters. */
async function oracleFusion(
  fusionCase: FusionCase,
  analysisId: string,
  clockTag: string,
  skew: 'monotonic' | 'backwards' | 'jitter',
  clockSeed: number,
): Promise<unknown> {
  const { outcome } = await runFusion(
    realFusion(fusionCase.declared),
    fusionCase,
    analysisId,
    clockTag,
    skew,
    mulberry32(clockSeed),
  );
  return outcome;
}

async function burstFusionShared(
  seed: number,
  rng: Rng,
  detail: string[],
  outcomes: Tally,
): Promise<number> {
  const k = int(rng, 4, 12);
  const distinct = int(rng, 1, k);
  const pool = Array.from({ length: distinct }, (_, i) =>
    seededFusionCase(rng, i),
  );
  const cases = Array.from({ length: k }, (_, i) => pool[i % distinct]!);
  const inputHashes = cases.map(c => hashOf({ s: c.sequence, p: c.paddle }));
  // The shared bundle is selected for the FIRST case's declaration: every
  // production entry supports every stroke, so one bundle serves them all.
  const shared = realFusion(cases[0]!.declared);
  const sched = new Scheduler(rng);
  const clockSeeds = cases.map(() => int(rng, 1, 1_000_000_000));

  const promises = cases.map((c, i) =>
    runFusion(
      wrapFusion(shared, sched, `run${i}`),
      c,
      `analysis-${seed}-${i}`,
      `run${i}`,
      'monotonic',
      mulberry32(clockSeeds[i]!),
    ),
  );
  // Abandoned callers race away; the analysis must still settle cleanly.
  const observed = cases.map((c, i) =>
    c.abandoned
      ? Promise.race([promises[i]!, Promise.resolve('abandoned' as const)])
      : promises[i]!,
  );
  await withDeadline(Promise.all(observed), `seed ${seed} fusion_shared`);
  const settled = await withDeadline(
    Promise.all(promises),
    `seed ${seed} fusion_shared (abandoned)`,
  );
  settled.forEach(s => tally(outcomes, describeOutcome(s.outcome)));
  // Snapshot NOW: the oracle runs later and must not share live state.
  const snapshots = settled.map(s => stableStringify(s.outcome));

  for (let i = 0; i < k; i += 1) {
    const c = cases[i]!;
    const expected = stableStringify(
      await oracleFusion(
        c,
        `analysis-${seed}-${i}`,
        `run${i}`,
        'monotonic',
        clockSeeds[i]!,
      ),
    );
    if (snapshots[i] !== expected) {
      detail.push(
        `run ${i} (${c.label}, declared=${String(c.declared)}) diverged from sequential oracle: ${snapshots[i]!.slice(0, 300)} vs ${expected.slice(0, 300)}`,
      );
    }
    if (hashOf({ s: c.sequence, p: c.paddle }) !== inputHashes[i]) {
      detail.push(`run ${i} mutated its input pose/paddle`);
    }
  }
  // Duplicate inputs must agree with each other byte for byte.
  for (let i = 0; i < k; i += 1) {
    for (let j = i + 1; j < k; j += 1) {
      if (cases[i] === cases[j]) {
        const a = identityNeutral(snapshots[i]!);
        const b = identityNeutral(snapshots[j]!);
        if (a !== b) detail.push(`duplicate calls ${i} and ${j} disagree`);
      }
    }
  }
  if (sched.switches === 0 && sched.activeTags.size >= 2)
    detail.push('runs did not interleave (harness fault)');
  return k;
}

async function burstFusionFresh(
  seed: number,
  rng: Rng,
  detail: string[],
  outcomes: Tally,
): Promise<number> {
  const k = int(rng, 4, 12);
  const cases = Array.from({ length: k }, (_, i) => seededFusionCase(rng, i));
  const sched = new Scheduler(rng);
  const clockSeeds = cases.map(() => int(rng, 1, 1_000_000_000));
  const platformPlan = cases.map(() => (rng() < 0.5 ? 'ios' : 'android'));
  const bundles: FusionProviders[] = [];
  const platformSeen: string[] = [];

  const promises = cases.map(async (c, i) => {
    await sched.yield();
    // Simulates the device context changing between two selections.
    mutablePlatform.OS = platformPlan[i]!;
    const platformAtCall = mutablePlatform.OS;
    const selection = createFusionProviders(c.declared);
    platformSeen.push(platformAtCall);
    if (selection.kind !== 'real') {
      throw new Error(`unavailable on ${platformAtCall}: ${selection.reason}`);
    }
    bundles.push(selection.providers);
    return runFusion(
      wrapFusion(selection.providers, sched, `run${i}`),
      c,
      `analysis-${seed}-${i}`,
      `run${i}`,
      'monotonic',
      mulberry32(clockSeeds[i]!),
    );
  });
  const settled = await withDeadline(
    Promise.all(promises),
    `seed ${seed} fusion_fresh`,
  );
  settled.forEach(s => tally(outcomes, describeOutcome(s.outcome)));
  const snapshots = settled.map(s => stableStringify(s.outcome));
  mutablePlatform.OS = 'ios';

  for (let i = 0; i < k; i += 1) {
    const expected = await oracleFusion(
      cases[i]!,
      `analysis-${seed}-${i}`,
      `run${i}`,
      'monotonic',
      clockSeeds[i]!,
    );
    if (snapshots[i] !== stableStringify(expected)) {
      detail.push(
        `run ${i} (platform ${platformSeen[i]}) diverged from oracle`,
      );
    }
  }
  // Fresh instances per selection: nothing shared between bundles.
  const seen = new Set<object>();
  for (const bundle of bundles) {
    for (const instance of [
      bundle.phase,
      bundle.biomechanics,
      bundle.scorer,
      bundle.faultDetector,
      bundle.uncertainty,
      bundle.coach,
      bundle.autoStrokeClassifier,
    ]) {
      if (!instance) continue;
      if (seen.has(instance))
        detail.push('two selections returned the same provider instance');
      seen.add(instance);
    }
    if (!bundle.autoStrokeClassifier)
      detail.push('AUTO DETECT classifier missing from a real bundle');
  }
  return k;
}

interface ClassifierCase {
  label: string;
  input: Parameters<IHierarchicalStrokeClassifier['classify']>[0];
}

function seededClassifierCase(rng: Rng, index: number): ClassifierCase {
  const truth = seededTruth(rng);
  const { sequence, window } = generateSwingSequence(truth);
  const handedness: 'left' | 'right' = rng() < 0.5 ? 'left' : 'right';
  const variant = int(rng, 0, 9);
  const base = {
    pose: sequence,
    paddle: seededPaddle(rng, sequence),
    ball: null,
    window: { startMs: window.startMs, endMs: window.endMs },
    contactMs: rng() < 0.5 ? window.peakMs : null,
    eventPeakMs: window.peakMs,
    handedness,
  };
  switch (variant) {
    case 0:
      return {
        label: `no-reference-${index}`,
        input: { ...base, contactMs: null, eventPeakMs: null },
      };
    case 1:
      return {
        label: `empty-pose-${index}`,
        input: { ...base, pose: { ...sequence, frames: [] } },
      };
    case 2:
      return {
        label: `inverted-window-${index}`,
        input: {
          ...base,
          window: { startMs: window.endMs, endMs: window.startMs },
        },
      };
    case 3:
      return {
        label: `nan-timestamps-${index}`,
        input: {
          ...base,
          pose: {
            ...sequence,
            frames: sequence.frames.map(f => ({
              ...f,
              timestampMs: Number.NaN,
            })),
          },
        },
      };
    case 4:
      return {
        label: `no-landmarks-${index}`,
        input: {
          ...base,
          pose: {
            ...sequence,
            frames: sequence.frames.map(f => ({ ...f, landmarks: [] })),
          },
        },
      };
    case 5:
      return {
        label: `paddle-all-null-centers-${index}`,
        input: {
          ...base,
          paddle: base.paddle
            ? {
                ...base.paddle,
                observations: base.paddle.observations.map(o => ({
                  ...o,
                  keypoints: { ...o.keypoints, center: null },
                })),
              }
            : null,
        },
      };
    case 6:
      return {
        label: `single-frame-${index}`,
        input: {
          ...base,
          pose: { ...sequence, frames: sequence.frames.slice(0, 1) },
        },
      };
    case 7:
      return {
        label: `far-reference-${index}`,
        input: { ...base, contactMs: 10_000_000, eventPeakMs: 10_000_000 },
      };
    default:
      return { label: `valid-${index}`, input: base };
  }
}

async function burstClassifier(
  seed: number,
  rng: Rng,
  detail: string[],
  outcomes: Tally,
): Promise<number> {
  const k = int(rng, 6, 16);
  const cases = Array.from({ length: k }, (_, i) =>
    seededClassifierCase(rng, i),
  );
  const inputHashes = cases.map(c => hashOf(c.input));
  const shared = realFusion(null).autoStrokeClassifier;
  if (!shared) throw new Error('AUTO DETECT classifier missing');
  const sched = new Scheduler(rng);

  const settled = await withDeadline(
    Promise.allSettled(
      cases.map((c, i) => sched.wrap(shared, `cls${i}`).classify(c.input)),
    ),
    `seed ${seed} classifier_burst`,
  );
  settled.forEach(s => tally(outcomes, describeOutcome(s)));
  const normalize = (r: PromiseSettledResult<unknown>): string =>
    stableStringify(
      r.status === 'fulfilled'
        ? { status: 'fulfilled', value: r.value }
        : {
            status: 'rejected',
            reason:
              r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );
  const snapshots = settled.map(normalize);
  for (let i = 0; i < k; i += 1) {
    const fresh = realFusion(null).autoStrokeClassifier!;
    const expected = normalize(
      await Promise.allSettled([fresh.classify(cases[i]!.input)]).then(
        r => r[0]!,
      ),
    );
    if (snapshots[i] !== expected) {
      detail.push(
        `${cases[i]!.label}: concurrent ${snapshots[i]!.slice(0, 200)} vs sequential ${expected.slice(0, 200)}`,
      );
    }
    if (hashOf(cases[i]!.input) !== inputHashes[i])
      detail.push(`${cases[i]!.label}: input mutated`);
  }
  return k;
}

interface LegacyCase {
  label: string;
  shotType: ShotTypeSlug;
  recording: RecordedStrokeInput | null;
  clip: {
    uri: string;
    durationMs: number;
    fps: number;
    width: number;
    height: number;
  };
  handedness: 'left' | 'right';
}

function seededLegacyCase(rng: Rng, index: number): LegacyCase {
  const swing = generateSwing(seededTruth(rng));
  const variant = int(rng, 0, 7);
  const recording: RecordedStrokeInput = {
    poseFrames: swing.frames,
    poseModelVersion: 'apple-vision-bodypose-1',
    trigger: {
      modelVersion: 'temporal-stroke-heuristic-2',
      startMs: swing.window.startMs,
      endMs: swing.window.endMs,
      peakMotionMs: swing.window.peakMs,
      confidence: 0.86,
    },
    video: { width: swing.clip.width, height: swing.clip.height },
  };
  const clip = {
    uri: swing.clip.uri,
    durationMs: swing.clip.durationMs,
    fps: swing.clip.fps,
    width: swing.clip.width,
    height: swing.clip.height,
  };
  const shotType = pick(rng, SHOT_TYPES);
  const handedness: 'left' | 'right' = rng() < 0.5 ? 'left' : 'right';
  if (variant === 0)
    return {
      label: `missing-${index}`,
      shotType,
      recording: null,
      clip,
      handedness,
    };
  if (variant === 1) {
    return {
      label: `starved-${index}`,
      shotType,
      recording: {
        ...recording,
        poseFrames: swing.frames.slice(0, int(rng, 0, 5)),
      },
      clip,
      handedness,
    };
  }
  if (variant === 2) {
    return {
      label: `inverted-trigger-${index}`,
      shotType,
      recording: {
        ...recording,
        trigger: {
          ...recording.trigger,
          startMs: recording.trigger.endMs,
          endMs: recording.trigger.startMs,
        },
      },
      clip,
      handedness,
    };
  }
  if (variant === 3) {
    // Frames handed over out of order: the provider sorts a COPY.
    return {
      label: `shuffled-frames-${index}`,
      shotType,
      recording: { ...recording, poseFrames: [...swing.frames].reverse() },
      clip,
      handedness,
    };
  }
  return { label: `valid-${index}`, shotType, recording, clip, handedness };
}

async function runLegacy(
  providers: VisionProviderSet,
  c: LegacyCase,
  analysisId: string,
): Promise<unknown> {
  return analyzeClip(providers, c.clip, {
    analysisId,
    sessionId: null,
    shotType: c.shotType,
    handedness: c.handedness,
    cameraView: 'side',
    appVersion: '0.1.0',
    modelBundleVersion: scoringStackStatus().version,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
  });
}

async function burstLegacyShared(
  seed: number,
  rng: Rng,
  detail: string[],
  outcomes: Tally,
): Promise<number> {
  const k = int(rng, 4, 12);
  const distinct = int(rng, 1, k);
  const pool = Array.from({ length: distinct }, (_, i) =>
    seededLegacyCase(rng, i),
  );
  const cases = Array.from({ length: k }, (_, i) => pool[i % distinct]!);
  const inputHashes = cases.map(c => hashOf(c.recording));
  const sched = new Scheduler(rng);

  const promises = cases.map(async (c, i) => {
    await sched.yield();
    const availability = selectVisionProviders(c.shotType, c.recording);
    if (availability.kind !== 'real')
      return { kind: 'unavailable', reason: availability.reason };
    return runLegacy(
      wrapLegacy(availability.providers, sched, `leg${i}`),
      c,
      `legacy-${seed}-${i}`,
    );
  });
  const settled = await withDeadline(
    Promise.all(promises),
    `seed ${seed} legacy_shared`,
  );
  settled.forEach(s => tally(outcomes, describeOutcome(s)));
  const snapshots = settled.map(s => stableStringify(s));

  for (let i = 0; i < k; i += 1) {
    const c = cases[i]!;
    const availability = selectVisionProviders(c.shotType, c.recording);
    const expected =
      availability.kind !== 'real'
        ? { kind: 'unavailable', reason: availability.reason }
        : await runLegacy(availability.providers, c, `legacy-${seed}-${i}`);
    if (snapshots[i] !== stableStringify(expected)) {
      detail.push(
        `${c.label}: concurrent result diverged from sequential oracle`,
      );
    }
    if (hashOf(c.recording) !== inputHashes[i])
      detail.push(
        `${c.label}: recording mutated by provider selection/analysis`,
      );
    if (c.recording === null && availability.kind !== 'unavailable')
      detail.push(`${c.label}: providers issued without a recording`);
    if (
      c.recording &&
      c.recording.poseFrames.length < 6 &&
      availability.kind !== 'unavailable'
    ) {
      detail.push(
        `${c.label}: providers issued for ${c.recording.poseFrames.length} frames`,
      );
    }
  }
  return k;
}

async function burstClockSkew(
  seed: number,
  rng: Rng,
  detail: string[],
  outcomes: Tally,
): Promise<number> {
  const k = int(rng, 4, 10);
  const cases = Array.from({ length: k }, (_, i) => seededFusionCase(rng, i));
  const skews = cases.map(() =>
    pick(rng, ['monotonic', 'backwards', 'jitter'] as const),
  );
  const clockSeeds = cases.map(() => int(rng, 1, 1_000_000_000));
  const shared = realFusion(cases[0]!.declared);
  const sched = new Scheduler(rng);

  const settled = await withDeadline(
    Promise.all(
      cases.map((c, i) =>
        runFusion(
          wrapFusion(shared, sched, `clk${i}`),
          c,
          `skew-${seed}-${i}`,
          `clk${i}`,
          skews[i]!,
          mulberry32(clockSeeds[i]!),
        ),
      ),
    ),
    `seed ${seed} clock_skew`,
  );
  settled.forEach(s => tally(outcomes, describeOutcome(s.outcome)));
  const snapshots = settled.map(s => stableStringify(s.outcome));
  const allIds = new Set<string>();
  for (let i = 0; i < k; i += 1) {
    const { clock } = settled[i]!;
    const expected = await oracleFusion(
      cases[i]!,
      `skew-${seed}-${i}`,
      `clk${i}`,
      skews[i]!,
      clockSeeds[i]!,
    );
    if (snapshots[i] !== stableStringify(expected))
      detail.push(`run ${i} (${skews[i]}) diverged from oracle`);
    const text = snapshots[i]!;
    // Every timestamp/id in the record must come from THIS run's clock.
    const isoMatches =
      text.match(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"/g) ?? [];
    const own = new Set([...clock.issuedTimes, '2026-09-04T12:00:00.000Z']);
    for (const m of isoMatches) {
      if (!own.has(m.slice(1, -1)))
        detail.push(`run ${i}: timestamp ${m} not issued by its own clock`);
    }
    for (const id of clock.issuedIds) {
      if (allIds.has(id)) detail.push(`duplicate model-run id ${id}`);
      allIds.add(id);
    }
    const idMatches = text.match(/"clk\d+-id-\d+"/g) ?? [];
    for (const m of idMatches) {
      if (!m.startsWith(`"clk${i}-id-`))
        detail.push(`run ${i}: model-run id ${m} leaked from another run`);
    }
  }
  return k;
}

// ─── Campaign ───────────────────────────────────────────────────────────────

async function iteration(seed: number): Promise<IterationRow> {
  const rng = mulberry32(seed);
  const kind = pick(rng, KINDS);
  const detail: string[] = [];
  const outcomes: Tally = {};
  const registryBefore = hashOf(registry.list());
  const started = Date.now();
  let concurrency = 0;
  liveSchedulers.length = 0;
  try {
    const runner =
      kind === 'fusion_shared'
        ? burstFusionShared
        : kind === 'fusion_fresh'
          ? burstFusionFresh
          : kind === 'classifier_burst'
            ? burstClassifier
            : kind === 'legacy_shared'
              ? burstLegacyShared
              : burstClockSkew;
    concurrency = await runner(seed, rng, detail, outcomes);
  } catch (error) {
    detail.push(
      `threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    mutablePlatform.OS = 'ios';
  }
  if (hashOf(registry.list()) !== registryBefore)
    detail.push('registry contents changed during burst');
  scenariosExecuted += concurrency;
  return {
    seed,
    kind,
    concurrency,
    maxInFlight: Math.max(0, ...liveSchedulers.map(s => s.maxInFlight)),
    switches: liveSchedulers.reduce((n, s) => n + s.switches, 0),
    activeRuns: liveSchedulers.reduce((n, s) => n + s.activeTags.size, 0),
    yields: liveSchedulers.reduce((n, s) => n + s.yields, 0),
    providerCalls: liveSchedulers.reduce((n, s) => n + s.calls, 0),
    durationMs: Date.now() - started,
    outcome: detail.length === 0 ? 'HELD' : 'BROKEN',
    detail,
    outcomes,
  };
}

const SEEDS =
  REPLAY_SEEDS.length > 0
    ? REPLAY_SEEDS
    : Array.from({ length: ITERATIONS }, (_, i) => 1_000 + i);

describe('vision/providers — seeded concurrency campaign', () => {
  jest.setTimeout(Math.max(120_000, SEEDS.length * 2_000));

  it('registry resolution is pure: bursts of resolve() never mutate the manifest', () => {
    const before = hashOf(registry.list());
    const bursts = Array.from({ length: 200 }, (_, i) => {
      const rng = mulberry32(i + 1);
      return registry.resolve({
        task: 'technique_scoring',
        platform: rng() < 0.5 ? 'ios' : 'android',
        ...(rng() < 0.5 ? { stroke: pick(rng, SHOT_TYPES) } : {}),
      });
    });
    expect(bursts.every(entry => entry?.id === 'scorer.sm-v1')).toBe(true);
    expect(hashOf(registry.list())).toBe(before);
  });

  it(`every seeded interleaving (${SEEDS.length} bursts) matches the sequential oracle`, async () => {
    for (const seed of SEEDS) {
      rows.push(await iteration(seed));
    }
    const broken = rows.filter(r => r.outcome === 'BROKEN');
    expect(
      broken.map(r => `seed ${r.seed} [${r.kind}] ${r.detail.join(' | ')}`),
    ).toEqual([]);
    // Evidence the scheduler really interleaved runs (not K sequential passes).
    expect(
      rows
        .filter(r => r.activeRuns >= 2 && r.switches === 0)
        .map(
          r =>
            `seed ${r.seed} [${r.kind}] ${r.activeRuns} runs never interleaved`,
        ),
    ).toEqual([]);
    expect(rows.filter(r => r.switches > 0).length).toBeGreaterThan(
      rows.length / 2,
    );
  });

  it('a platform flip mid-burst is observed atomically by every selection', async () => {
    const rng = mulberry32(42);
    const sched = new Scheduler(rng);
    const outcomes = await Promise.all(
      Array.from({ length: 32 }, async (_, i) => {
        await sched.yield();
        mutablePlatform.OS = i % 3 === 0 ? 'android' : 'ios';
        const selection = createFusionProviders(i % 2 === 0 ? null : 'dink');
        return selection.kind;
      }),
    );
    mutablePlatform.OS = 'ios';
    expect(outcomes.every(kind => kind === 'real')).toBe(true);
  });
});

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  const held = rows.filter(r => r.outcome === 'HELD').length;
  writeFileSync(
    join(OUT_DIR, 'vision-providers-concurrency.json'),
    JSON.stringify(
      {
        unit: 'apps/mobile/src/vision/providers.ts',
        lens: 'concurrency',
        iterations: rows.length,
        scenariosExecuted,
        held,
        broken: rows.length - held,
        byKind: KINDS.map(kind => ({
          kind,
          iterations: rows.filter(r => r.kind === kind).length,
          scenarios: rows
            .filter(r => r.kind === kind)
            .reduce((n, r) => n + r.concurrency, 0),
          broken: rows.filter(r => r.kind === kind && r.outcome === 'BROKEN')
            .length,
          maxInFlight: Math.max(
            0,
            ...rows.filter(r => r.kind === kind).map(r => r.maxInFlight),
          ),
          switches: rows
            .filter(r => r.kind === kind)
            .reduce((n, r) => n + r.switches, 0),
        })),
        outcomesOverall: rows.reduce<Tally>((acc, r) => {
          for (const [key, n] of Object.entries(r.outcomes))
            acc[key] = (acc[key] ?? 0) + n;
          return acc;
        }, {}),
        maxInFlightOverall: Math.max(0, ...rows.map(r => r.maxInFlight)),
        totalSwitches: rows.reduce((n, r) => n + r.switches, 0),
        rows,
      },
      null,
      2,
    ),
  );
});
