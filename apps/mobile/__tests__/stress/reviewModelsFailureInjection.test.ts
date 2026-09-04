/**
 * STRESS — failure injection for the review model layer
 * (src/review/formReviewModel, formReviewGeometry, poseSidecar,
 * recommendedDrillsModel, appStoreReview).
 *
 * Every dependency the unit touches is made to misbehave in turn — the native
 * capture-file reader (camera bridge), the swing-domain hash + parser, the
 * device SQLite kv, the StoreKit native module, `Linking`, `Platform`, the
 * clock — with throw / reject / timeout / malformed / partial / slow /
 * never-resolves behaviour, plus hostile persisted records (the analysis rows
 * are unvalidated JSON from the local database).
 *
 * Invariants asserted per fault:
 *   - the module never throws out of a documented "returns null" path;
 *   - no fake success (a failed dependency never yields a positive result);
 *   - no silent state corruption (the kv record is always parseable and its
 *     counters finite, non-negative integers; other keys are untouched);
 *   - slow dependencies settle once fake timers advance; a dependency that
 *     never settles is reported (60 s fake-timer budget);
 *   - every user-facing string produced from a record is a real, non-empty
 *     string (no `undefined`, no leaked function source).
 *
 * Replay: every iteration is a pure function of its seed. `seed % FAULTS.length`
 * selects the fault; a mulberry32 stream seeded with the seed drives every
 * random parameter. `STRESS_SEED=<n>` runs exactly one seed,
 * `STRESS_ITER=<n>` sets the total iteration count (default 3× the catalog,
 * the first pass always sweeps every fault once), `STRESS_OUT=<dir>` moves
 * the JSON seed→outcome table (default apps/mobile/artifacts/stress/).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as sharedReactNative from 'react-native';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { CHECKPOINTS, PHASES } from '@pickle/shared-types';
import type { PoseSequence } from '@pickle/swing-domain';
import { generateSwingSequence } from '@pickle/evaluation';
import type { PoseSequenceSidecarRef } from '../../src/camera/capture';
import {
  POSE_FRAME_TOLERANCE_MS,
  REVIEW_JOINTS,
  buildFormReviewScript,
  dominantSide,
  facingSign,
  fixList,
  jointHeatAt,
  poseFrameAt,
  reviewVideoSize,
  strengthList,
  type FormReviewScript,
  type ReviewPoseFrame,
  type ReviewPoseSequence,
  type ReviewStop,
} from '../../src/review/formReviewModel';
import {
  TORSO_UNIT_FALLBACK,
  arrowVector,
  containRect,
  currentStop,
  faultTint,
  heatRampColor,
  heatTint,
  nextAutoPause,
  speedLabel,
  stagePoint,
  torsoUnit,
} from '../../src/review/formReviewGeometry';
import {
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from '../../src/review/recommendedDrillsModel';
import { loadReviewPoseSequence } from '../../src/review/poseSidecar';
import * as sharedReview from '../../src/review/appStoreReview';

type SwingDomain = typeof import('@pickle/swing-domain');
const domain = jest.requireActual<SwingDomain>('@pickle/swing-domain');

// ─── Injectable dependencies ────────────────────────────────────────────────
// The jest.mock factories are hoisted; they only close over these controllers
// and read them at call time, so every scenario reconfigures them freely.

const mockCapture: { read: (uri: string) => unknown } = {
  read: () => Promise.reject(new Error('capture read not configured')),
};

const mockDomain: {
  sha256: (input: string) => string;
  parse: SwingDomain['parsePoseSequence'];
} = {
  sha256: input => domain.sha256Hex(input),
  parse: (json, producedBy) => domain.parsePoseSequence(json, producedBy),
};

type SqlOp = 'select' | 'insert';
type SqlBehavior =
  | { kind: 'ok' }
  | { kind: 'reject' }
  | { kind: 'throw' }
  | { kind: 'hang' }
  | { kind: 'slow'; ms: number }
  | { kind: 'resolve-undefined' }
  | { kind: 'rows-undefined' }
  | { kind: 'wrong-column' }
  | { kind: 'value'; value: unknown }
  | { kind: 'lost-write' };

const mockDb = {
  table: new Map<string, string>(),
  select: { kind: 'ok' } as SqlBehavior,
  insert: { kind: 'ok' } as SqlBehavior,
  getDbThrows: false,
  ops: [] as SqlOp[],
  reset() {
    this.table.clear();
    this.select = { kind: 'ok' };
    this.insert = { kind: 'ok' };
    this.getDbThrows = false;
    this.ops = [];
  },
  getDb() {
    if (this.getDbThrows) throw new Error('sqlite: open failed');
    return {
      execute: (sql: string, params: unknown[] = []) =>
        this.execute(sql, params),
      close() {},
    };
  },
  execute(sql: string, params: unknown[]): unknown {
    const op: SqlOp = sql.startsWith('SELECT') ? 'select' : 'insert';
    this.ops.push(op);
    const behavior = op === 'select' ? this.select : this.insert;
    const key = String(params[0]);
    const commit = () => {
      if (op === 'select') {
        const value = this.table.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      this.table.set(key, String(params[1]));
      return { rows: [] };
    };
    switch (behavior.kind) {
      case 'ok':
        return Promise.resolve(commit());
      case 'reject':
        return Promise.reject(new Error(`sqlite: ${op} failed`));
      case 'throw':
        throw new Error(`sqlite: ${op} threw synchronously`);
      case 'hang':
        return new Promise(() => {});
      case 'slow':
        return new Promise(resolve =>
          setTimeout(() => resolve(commit()), behavior.ms),
        );
      case 'resolve-undefined':
        return Promise.resolve(undefined);
      case 'rows-undefined':
        return Promise.resolve({ rows: undefined });
      case 'wrong-column':
        return Promise.resolve({ rows: [{ val: this.table.get(key) }] });
      case 'value':
        return Promise.resolve({ rows: [{ value: behavior.value }] });
      case 'lost-write':
        return Promise.resolve({ rows: [] });
    }
  },
};

jest.mock('../../src/camera/capture', () => ({
  readCaptureArtifact: (uri: string) => mockCapture.read(uri),
}));

jest.mock('@pickle/swing-domain', () => {
  const actual = jest.requireActual('@pickle/swing-domain');
  return {
    ...actual,
    sha256Hex: (input: string) => mockDomain.sha256(input),
    parsePoseSequence: (
      json: string,
      producedBy: Parameters<SwingDomain['parsePoseSequence']>[1],
    ) => mockDomain.parse(json, producedBy),
  };
});

jest.mock('../../src/data/db', () => ({
  getDb: () => mockDb.getDb(),
}));

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

const BASE_ANALYSIS: ShotAnalysis = {
  id: 'analysis-stress',
  sessionId: 'set-stress',
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
  phases: [
    phase('ready', 0, 900),
    phase('prepare', 900, 1500),
    phase('accelerate', 1500, 1900),
    phase('contact', 1880, 1920, 1900),
    phase('follow_through', 1920, 2400),
    phase('recover', 2400, 3200),
  ],
  measurements: [],
  checkpoints: [
    checkpoint('ready_position', 85, 'green', 'none'),
    checkpoint('athletic_base', 72, 'yellow', 'narrow'),
    checkpoint('preparation', 88, 'green', 'none'),
    checkpoint('paddle_set', 90, 'green', 'none'),
    checkpoint('swing_length', null, 'unscored', 'none'),
    checkpoint('sequencing', 82, 'green', 'none'),
    checkpoint('paddle_path', 61, 'red', 'low'),
    checkpoint('contact_position', 48, 'red', 'late'),
    checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
      applicable: false,
    }),
    checkpoint('follow_through', 80, 'green', 'short'),
    checkpoint('recovery', 92, 'green', 'none'),
  ],
  overallScore: 7.1,
  analysisConfidence: 0.84,
  resultKind: 'scored',
  guidance: null,
  priorityFix: {
    checkpoint: 'contact_position',
    reasonKey: 'lowest_score',
    severity: 0.52,
    confidence: 0.8,
  },
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'on-device-fusion-1',
    poseModelVersion: 'apple-vision-bodypose-1',
    paddleModelVersion: 'none',
    strokeDetectorVersion: 'temporal-stroke-heuristic-2',
    phaseModelVersion: 'phase-geometry-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

function cloneAnalysis(): ShotAnalysis {
  return JSON.parse(JSON.stringify(BASE_ANALYSIS)) as ShotAnalysis;
}

/** Any-shaped view of an analysis so hostile field values can be injected. */
type Loose = Record<string, unknown>;
function loose(analysis: ShotAnalysis): Loose {
  return analysis as unknown as Loose;
}

function frameAt(
  timestampMs: number,
  joints: Partial<Record<string, { x: number; y: number }>>,
  visibility = 0.95,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: Object.entries(joints).map(([name, point]) => ({
      name,
      x: point!.x,
      y: point!.y,
      visibility,
    })),
  };
}

function fullBodySequence(stepMs = 40, endMs = 3200): ReviewPoseSequence {
  const frames: ReviewPoseFrame[] = [];
  for (let t = 0; t <= endMs; t += stepMs) {
    const sweep = t / endMs;
    frames.push(
      frameAt(t, {
        head: { x: 0.5, y: 0.18 },
        left_shoulder: { x: 0.45, y: 0.3 },
        right_shoulder: { x: 0.55, y: 0.3 },
        left_elbow: { x: 0.4, y: 0.42 },
        right_elbow: { x: 0.62, y: 0.42 },
        left_wrist: { x: 0.38, y: 0.52 },
        right_wrist: { x: 0.3 + 0.4 * sweep, y: 0.5 },
        left_hip: { x: 0.46, y: 0.55 },
        right_hip: { x: 0.54, y: 0.55 },
        left_knee: { x: 0.46, y: 0.72 },
        right_knee: { x: 0.54, y: 0.72 },
        left_ankle: { x: 0.45, y: 0.9 },
        right_ankle: { x: 0.55, y: 0.9 },
      }),
    );
  }
  return { frames, video: { width: 1080, height: 1920, fps: 30 } };
}

let cachedSidecar: { sequence: PoseSequence; json: string } | null = null;
function validSidecar(): { sequence: PoseSequence; json: string } {
  if (!cachedSidecar) {
    const { sequence } = generateSwingSequence();
    cachedSidecar = { sequence, json: domain.serializePoseSequence(sequence) };
  }
  return cachedSidecar;
}

function refFor(
  json: string,
  overrides: Partial<PoseSequenceSidecarRef> = {},
): PoseSequenceSidecarRef {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///captures/clip.pose.json',
    frameCount: 0,
    sha256: domain.sha256Hex(json),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
    ...overrides,
  };
}

const DRILLS = [
  { slug: 'drive-a', families: ['drive'] },
  { slug: 'drive-b', families: ['drive', 'global'] },
  { slug: 'dink-a', families: ['dink'] },
  { slug: 'global-a', families: ['global'] },
  { slug: 'global-b', families: ['global'] },
  { slug: 'serve-a', families: ['serve'] },
];

const PROTO_KEYS = [
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
] as const;

const NON_FINITE = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
] as const;

const GARBAGE_VALUES: readonly unknown[] = [
  null,
  undefined,
  '',
  'garbage',
  42,
  -1,
  true,
  {},
  [],
  () => 1,
];

const ONE_MINUTE_MS = 60_000;

// ─── Probe: collects invariant violations for one iteration ─────────────────

class Probe {
  readonly violations: string[] = [];
  readonly notes: string[] = [];

  check(condition: boolean, message: string): void {
    if (!condition) this.violations.push(message);
  }

  note(message: string): void {
    this.notes.push(message);
  }
}

function realString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    !/function |\[native code\]|\[object |undefined|NaN/.test(value)
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `threw ${typeof error}: ${String(error)}`;
}

/** Runs `fn`, records a violation if it throws, returns its value or null. */
function neverThrows<T>(probe: Probe, label: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    probe.violations.push(`${label} threw — ${describeError(error)}`);
    return null;
  }
}

/** Fake timers that leave the macrotask drain (`setImmediate`) real, so a
 * promise chain of any depth can be flushed without advancing the clock. */
function useFakeClock(): void {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'clearImmediate', 'nextTick'],
  });
}

/** Fakes ONLY `Date` (wall clock); every timer stays real so the shared
 * module's `delay()` still fires and the queue cannot be left wedged. */
function useFakeDate(): void {
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
      'hrtime',
      'performance',
    ],
  });
}

const realSetTimeout = globalThis.setTimeout;

/** Drains every pending microtask (any chain depth) plus any REAL zero-delay
 * timer (`delay(0)`), via real macrotasks — works under fake timers too. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await new Promise<void>(resolve => realSetTimeout(resolve, 1));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

type Settled<T> = { settled: boolean; value?: T; error?: unknown };

/** Observes a promise without awaiting it (a hung promise stays `settled:false`). */
function track<T>(promise: Promise<T>): Settled<T> {
  const out: Settled<T> = { settled: false };
  void promise.then(
    value => {
      out.settled = true;
      out.value = value;
    },
    error => {
      out.settled = true;
      out.error = error;
    },
  );
  return out;
}

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  const out = track(promise);
  await flush();
  return out;
}

/** Waits (real time, bounded) for a batch of promises that a serialized queue
 * runs one after another; hung members are reported, never awaited forever. */
async function settleAll<T>(
  promises: Promise<T>[],
  budgetMs = 5_000,
): Promise<Settled<T>[]> {
  const outs = promises.map(track);
  await Promise.race([
    Promise.allSettled(promises),
    new Promise<void>(resolve => realSetTimeout(resolve, budgetMs)),
  ]);
  await flush();
  return outs;
}

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  await flush();
}

// ─── Script invariants (shared by every review-model fault) ─────────────────

function checkScript(probe: Probe, script: FormReviewScript | null): void {
  if (!script) return;
  probe.check(
    script.dominant === 'left' || script.dominant === 'right',
    `dominant must be a side, got ${String(script.dominant)}`,
  );
  probe.check(
    script.facing === 1 || script.facing === -1,
    `facing must be ±1, got ${String(script.facing)}`,
  );
  probe.check(Array.isArray(script.stops), 'stops must be an array');
  const ids = new Set<string>();
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const stop of script.stops) {
    probe.check(!ids.has(stop.id), `duplicate stop id ${stop.id}`);
    ids.add(stop.id);
    probe.check(
      (PHASES as readonly string[]).includes(stop.phase),
      `stop phase ${String(stop.phase)} is not a phase`,
    );
    probe.check(
      Number.isFinite(stop.atMs) &&
        Number.isFinite(stop.startMs) &&
        Number.isFinite(stop.endMs),
      `stop ${stop.id} has non-finite timing`,
    );
    probe.check(
      stop.startMs <= stop.endMs,
      `stop ${stop.id} span inverted ${stop.startMs}>${stop.endMs}`,
    );
    probe.check(stop.atMs >= previousAt, `stops not sorted at ${stop.id}`);
    previousAt = stop.atMs;
    probe.check(realString(stop.title), `stop ${stop.id} title not a string`);
    probe.check(
      realString(stop.headline),
      `stop ${stop.id} headline unusable: ${JSON.stringify(stop.headline)}`,
    );
    probe.check(
      realString(stop.cue),
      `stop ${stop.id} cue unusable: ${JSON.stringify(stop.cue)}`,
    );
    for (const joint of stop.focusJoints) {
      probe.check(
        (REVIEW_JOINTS as readonly string[]).includes(joint),
        `focus joint ${String(joint)} unknown`,
      );
    }
    if (stop.arrow) {
      probe.check(
        (REVIEW_JOINTS as readonly string[]).includes(stop.arrow.joint),
        `arrow joint ${String(stop.arrow.joint)} unknown`,
      );
      probe.check(realString(stop.arrow.label), 'arrow label unusable');
    }
    for (const cp of stop.checkpoints) {
      probe.check(
        (CHECKPOINTS as readonly string[]).includes(cp.key),
        `stop checkpoint key ${String(cp.key)} unknown`,
      );
      probe.check(Number.isFinite(cp.score), `checkpoint ${cp.key} score NaN`);
      probe.check(realString(cp.name), `checkpoint ${cp.key} name unusable`);
    }
  }
  for (const [joint, heat] of Object.entries(script.jointHeat)) {
    probe.check(
      (REVIEW_JOINTS as readonly string[]).includes(joint),
      `jointHeat key ${joint} unknown`,
    );
    probe.check(
      typeof heat === 'number' && heat >= 0 && heat <= 1,
      `jointHeat ${joint}=${String(heat)} outside 0..1`,
    );
  }
  if (script.strongest && script.weakest) {
    probe.check(
      script.strongest.score >= script.weakest.score,
      'strongest scored below weakest',
    );
  }
  for (const t of [Number.NaN, -1e9, 0, 1900, 1e9, ...NON_FINITE]) {
    const heat = neverThrows(probe, `jointHeatAt(${t})`, () =>
      jointHeatAt(script, t),
    );
    if (heat) {
      for (const [joint, value] of Object.entries(heat)) {
        probe.check(
          typeof value === 'number' && value >= 0 && value <= 1,
          `jointHeatAt(${t}) ${joint}=${String(value)} outside 0..1`,
        );
      }
    }
  }
}

function checkFixList(probe: Probe, analysis: ShotAnalysis): void {
  const fixes = neverThrows(probe, 'fixList', () => fixList(analysis));
  if (fixes) {
    probe.check(fixes.length <= 3, `fixList returned ${fixes.length} > 3`);
    for (const fix of fixes) {
      probe.check(
        fix.band === 'yellow' || fix.band === 'red',
        `fixList leaked band ${String(fix.band)}`,
      );
      probe.check(Number.isFinite(fix.score), `fix ${fix.key} score NaN`);
      probe.check(
        realString(fix.headline),
        `fix ${fix.key} headline unusable: ${JSON.stringify(fix.headline)}`,
      );
      probe.check(
        realString(fix.cue),
        `fix ${fix.key} cue unusable: ${JSON.stringify(fix.cue)}`,
      );
      probe.check(
        (PHASES as readonly string[]).includes(fix.phase),
        `fix ${fix.key} phase ${String(fix.phase)} unknown`,
      );
    }
  }
  const strengths = neverThrows(probe, 'strengthList', () =>
    strengthList(analysis),
  );
  if (strengths) {
    probe.check(strengths.length <= 2, 'strengthList exceeded limit');
    for (const cp of strengths) {
      probe.check(cp.band === 'green', `strength leaked band ${cp.band}`);
    }
  }
  const focus = neverThrows(probe, 'drillFocusFromAnalysis', () =>
    drillFocusFromAnalysis(analysis),
  );
  if (focus) {
    probe.check(
      Number.isInteger(focus.averageScore),
      `focus averageScore ${String(focus.averageScore)} not an integer`,
    );
    probe.check(
      realString(focus.family),
      `focus family unusable: ${String(focus.family)}`,
    );
    probe.check(
      (CHECKPOINTS as readonly string[]).includes(focus.checkpoint),
      `focus checkpoint ${String(focus.checkpoint)} unknown`,
    );
    const picks = neverThrows(probe, 'pickRecommendedDrills', () =>
      pickRecommendedDrills(DRILLS, focus, 3),
    );
    if (picks) {
      probe.check(picks.length <= 3, 'drills exceeded limit');
      probe.check(
        new Set(picks.map(d => d.slug)).size === picks.length,
        'duplicate drill recommended',
      );
    }
  }
}

function runReviewModel(
  probe: Probe,
  analysis: ShotAnalysis,
  sequence: ReviewPoseSequence | null,
): FormReviewScript | null {
  const frozenAnalysis = deepFreeze(analysis);
  const frozenSequence = sequence ? deepFreeze(sequence) : null;
  const first = neverThrows(probe, 'buildFormReviewScript', () =>
    buildFormReviewScript(frozenAnalysis, frozenSequence),
  );
  const second = neverThrows(probe, 'buildFormReviewScript#2', () =>
    buildFormReviewScript(frozenAnalysis, frozenSequence),
  );
  if (first && second) {
    probe.check(
      JSON.stringify(first) === JSON.stringify(second),
      'buildFormReviewScript is not deterministic for identical input',
    );
  }
  checkScript(probe, first);
  checkFixList(probe, frozenAnalysis);
  neverThrows(probe, 'dominantSide', () =>
    dominantSide(
      frozenSequence,
      { startMs: 1500, endMs: 2400 },
      frozenAnalysis.handedness,
    ),
  );
  neverThrows(probe, 'facingSign', () =>
    facingSign(frozenSequence, frozenAnalysis, 'right'),
  );
  return first;
}

function checkPoseLookups(
  probe: Probe,
  sequence: ReviewPoseSequence | null,
  times: readonly number[],
): void {
  for (const t of times) {
    const frame = neverThrows(probe, `poseFrameAt(${t})`, () =>
      poseFrameAt(sequence, t),
    );
    if (frame) {
      probe.check(
        Number.isFinite(t) &&
          Math.abs(frame.timestampMs - t) <= POSE_FRAME_TOLERANCE_MS,
        `poseFrameAt(${t}) returned a frame ${frame.timestampMs}ms away`,
      );
    }
  }
  const size = neverThrows(probe, 'reviewVideoSize', () =>
    reviewVideoSize(sequence),
  );
  if (size) {
    probe.check(
      size.width > 0 && size.height > 0 && Number.isFinite(size.fps),
      `reviewVideoSize leaked ${JSON.stringify(size)}`,
    );
  }
}

// ─── App Store review helpers ───────────────────────────────────────────────

type ReviewModule = typeof sharedReview;
type ReactNative = typeof sharedReactNative;

interface ReviewHarness {
  review: ReviewModule;
  rn: ReactNative;
}

/** The module keeps a global serialized queue; a fault that never settles
 * wedges it, so those faults get a private module instance. */
function isolatedReviewModule(): ReviewHarness {
  let harness: ReviewHarness | null = null;
  jest.isolateModules(() => {
    const rn = jest.requireActual<ReactNative>('react-native');
    const review = jest.requireActual<ReviewModule>(
      '../../src/review/appStoreReview',
    );
    harness = { rn, review };
  });
  if (!harness) throw new Error('isolateModules did not run');
  return harness;
}

function sharedReviewModule(): ReviewHarness {
  return { review: sharedReview, rn: sharedReactNative };
}

type NativeSlot = { PickleStoreReview?: unknown };

function installNative(
  rn: ReactNative,
  requestReview: (() => unknown) | 'missing' | 'no-method',
): void {
  const slot = rn.NativeModules as NativeSlot;
  if (requestReview === 'missing') {
    delete slot.PickleStoreReview;
  } else if (requestReview === 'no-method') {
    slot.PickleStoreReview = { somethingElse: true };
  } else {
    slot.PickleStoreReview = { requestReview };
  }
}

async function withPlatform<T>(
  rn: ReactNative,
  os: string,
  fn: () => Promise<T>,
): Promise<T> {
  const platform = rn.Platform as unknown as { OS: string };
  const previous = platform.OS;
  platform.OS = os;
  try {
    return await fn();
  } finally {
    platform.OS = previous;
  }
}

/** Persisted-state integrity: the kv record must always be parseable with
 * finite non-negative integer counters, and no other key may be touched. */
function checkPersisted(
  probe: Probe,
  review: ReviewModule,
  untouched: ReadonlyMap<string, string>,
): ReturnType<ReviewModule['parseReviewPromptState']> {
  const raw = mockDb.table.get(review.REVIEW_PROMPT_KV_KEY) ?? null;
  if (raw !== null) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      probe.violations.push(`persisted kv is not JSON: ${raw}`);
    }
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const field of ['scoredAnalyses', 'promptedCount']) {
        const value = record[field];
        probe.check(
          typeof value === 'number' && Number.isInteger(value) && value >= 0,
          `persisted ${field}=${String(value)} is not a non-negative integer`,
        );
      }
      for (const field of ['lastPromptedAtIso', 'reviewedAtIso']) {
        const value = record[field];
        probe.check(
          value === null ||
            (typeof value === 'string' &&
              Number.isFinite(new Date(value).getTime())),
          `persisted ${field}=${String(value)} is not null or an ISO date`,
        );
      }
      probe.check(record['version'] === 1, 'persisted version drifted');
    }
  }
  for (const [key, value] of untouched) {
    probe.check(
      mockDb.table.get(key) === value,
      `unrelated kv key ${key} was modified`,
    );
  }
  return review.parseReviewPromptState(raw);
}

function seedForeignKeys(rng: Rng): Map<string, string> {
  const foreign = new Map<string, string>();
  const count = int(rng, 0, 3);
  for (let i = 0; i < count; i += 1) {
    foreign.set(`other.key.${i}`, `value-${int(rng, 0, 9999)}`);
  }
  for (const [key, value] of foreign) mockDb.table.set(key, value);
  return foreign;
}

function seedReviewState(
  review: ReviewModule,
  state: Partial<ReturnType<ReviewModule['parseReviewPromptState']>>,
): void {
  mockDb.table.set(
    review.REVIEW_PROMPT_KV_KEY,
    JSON.stringify({
      version: 1,
      scoredAnalyses: 0,
      promptedCount: 0,
      lastPromptedAtIso: null,
      reviewedAtIso: null,
      ...state,
    }),
  );
}

// ─── Fault catalog ──────────────────────────────────────────────────────────

type Target =
  | 'poseSidecar'
  | 'appStoreReview'
  | 'formReviewModel'
  | 'formReviewGeometry'
  | 'recommendedDrillsModel';

type Mode =
  | 'throw'
  | 'reject'
  | 'timeout'
  | 'malformed'
  | 'partial'
  | 'slow'
  | 'never-resolves';

interface Fault {
  id: string;
  target: Target;
  dependency: string;
  mode: Mode;
  run: (rng: Rng, probe: Probe) => Promise<void> | void;
}

const SIDECAR_FAULTS: Fault[] = [
  {
    id: 'sidecar.read.throw-sync',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'throw',
    async run(rng, probe) {
      const { json } = validSidecar();
      mockCapture.read = () => {
        throw pick(rng, [new Error('boom'), 'string-throw', undefined, 42]);
      };
      const result = await loadReviewPoseSequence(refFor(json));
      probe.check(result === null, 'sync throw must yield null');
    },
  },
  {
    id: 'sidecar.read.reject-error',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'reject',
    async run(rng, probe) {
      const { json } = validSidecar();
      const code = pick(rng, [
        'file.invalid_uri',
        'file.unavailable',
        'file.outside_private_storage',
        'file.read_failed',
      ]);
      mockCapture.read = () => Promise.reject(new Error(code));
      const result = await loadReviewPoseSequence(refFor(json));
      probe.check(result === null, `reject(${code}) must yield null`);
    },
  },
  {
    id: 'sidecar.read.reject-non-error',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'reject',
    async run(rng, probe) {
      const { json } = validSidecar();
      const reason = pick(rng, GARBAGE_VALUES);
      mockCapture.read = () => Promise.reject(reason);
      const result = await loadReviewPoseSequence(refFor(json));
      probe.check(result === null, 'reject(non-error) must yield null');
    },
  },
  {
    id: 'sidecar.read.resolves-non-string',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      const value = pick(rng, [
        undefined,
        null,
        42,
        true,
        { json },
        JSON.parse(json) as unknown,
        [json],
      ]);
      mockCapture.read = () => Promise.resolve(value);
      const result = await loadReviewPoseSequence(refFor(json));
      probe.check(result === null, 'non-string artifact must yield null');
    },
  },
  {
    id: 'sidecar.read.empty-string',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'malformed',
    async run(_rng, probe) {
      mockCapture.read = () => Promise.resolve('');
      const result = await loadReviewPoseSequence(refFor(''));
      probe.check(result === null, 'empty artifact must yield null');
    },
  },
  {
    id: 'sidecar.read.truncated',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'partial',
    async run(rng, probe) {
      const { json } = validSidecar();
      const cut = json.slice(0, int(rng, 1, json.length - 1));
      mockCapture.read = () => Promise.resolve(cut);
      // Hash of the truncated bytes: the integrity check passes, the parser
      // must still refuse the partial document.
      const result = await loadReviewPoseSequence(refFor(cut));
      probe.check(result === null, `truncated at ${cut.length} yielded data`);
    },
  },
  {
    id: 'sidecar.read.bit-flip',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      const at = int(rng, 0, json.length - 1);
      const flipped =
        json.slice(0, at) + (json[at] === '0' ? '1' : '0') + json.slice(at + 1);
      mockCapture.read = () => Promise.resolve(flipped);
      const result = await loadReviewPoseSequence(refFor(json));
      probe.check(result === null, 'hash mismatch must yield null');
    },
  },
  {
    id: 'sidecar.ref.hash-malformed',
    target: 'poseSidecar',
    dependency: 'sidecar-ref',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      const good = domain.sha256Hex(json);
      const sha256 = pick(rng, [
        good.toUpperCase(),
        good.slice(0, 63),
        `${good}0`,
        '',
        undefined,
        null,
        42,
        good.replace(/./, 'z'),
      ]) as unknown as string;
      mockCapture.read = () => Promise.resolve(json);
      const result = await loadReviewPoseSequence(refFor(json, { sha256 }));
      probe.check(
        result === null,
        `sha256=${String(sha256)} must be refused (strict byte identity)`,
      );
    },
  },
  {
    id: 'sidecar.ref.uri-malformed',
    target: 'poseSidecar',
    dependency: 'sidecar-ref',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      let reads = 0;
      mockCapture.read = () => {
        reads += 1;
        return Promise.resolve(json);
      };
      const uri = pick(rng, ['', undefined, null, 42, {}, []]) as string;
      const result = await loadReviewPoseSequence(refFor(json, { uri }));
      probe.check(result === null, 'invalid uri must yield null');
      probe.check(reads === 0, 'invalid uri must not touch the native reader');
    },
  },
  {
    id: 'sidecar.ref.absent',
    target: 'poseSidecar',
    dependency: 'sidecar-ref',
    mode: 'malformed',
    async run(rng, probe) {
      let reads = 0;
      mockCapture.read = () => {
        reads += 1;
        return Promise.resolve('{}');
      };
      const ref = pick(rng, [null, undefined]);
      const result = await loadReviewPoseSequence(ref);
      probe.check(result === null, 'absent ref must yield null');
      probe.check(reads === 0, 'absent ref must not read');
    },
  },
  {
    id: 'sidecar.hash.throws',
    target: 'poseSidecar',
    dependency: 'swing-domain:sha256Hex',
    mode: 'throw',
    async run(_rng, probe) {
      const { json } = validSidecar();
      mockCapture.read = () => Promise.resolve(json);
      mockDomain.sha256 = () => {
        throw new Error('crypto unavailable');
      };
      const result = await loadReviewPoseSequence(refFor(json));
      probe.check(result === null, 'hash failure must yield null');
    },
  },
  {
    id: 'sidecar.hash.returns-garbage',
    target: 'poseSidecar',
    dependency: 'swing-domain:sha256Hex',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      mockCapture.read = () => Promise.resolve(json);
      const garbage = pick(rng, ['', 'deadbeef', undefined, null]);
      mockDomain.sha256 = () => garbage as string;
      const result = await loadReviewPoseSequence(refFor(json));
      probe.check(result === null, 'hash garbage must yield null');
    },
  },
  {
    id: 'sidecar.parse.throws',
    target: 'poseSidecar',
    dependency: 'swing-domain:parsePoseSequence',
    mode: 'throw',
    async run(_rng, probe) {
      const { json } = validSidecar();
      mockCapture.read = () => Promise.resolve(json);
      mockDomain.parse = () => {
        throw new RangeError('Maximum call stack size exceeded');
      };
      const outcome = await settle(loadReviewPoseSequence(refFor(json)));
      probe.check(outcome.settled, 'load must settle');
      probe.check(
        outcome.settled && !('error' in outcome) && outcome.value === null,
        `parser throw must yield null, got ${
          'error' in outcome
            ? `rejection ${describeError(outcome.error)}`
            : 'value'
        }`,
      );
    },
  },
  {
    id: 'sidecar.parse.returns-garbage',
    target: 'poseSidecar',
    dependency: 'swing-domain:parsePoseSequence',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      mockCapture.read = () => Promise.resolve(json);
      const garbage = pick(rng, [
        undefined,
        null,
        { ok: true },
        { ok: false },
        { ok: true, value: null },
      ]);
      mockDomain.parse = () =>
        garbage as unknown as ReturnType<SwingDomain['parsePoseSequence']>;
      const outcome = await settle(loadReviewPoseSequence(refFor(json)));
      probe.check(
        outcome.settled && !('error' in outcome),
        `parser garbage ${JSON.stringify(garbage)} must not reject`,
      );
      if (outcome.settled && 'value' in outcome && outcome.value) {
        probe.check(
          Array.isArray(outcome.value.frames),
          'parser garbage leaked a sequence without frames',
        );
      }
    },
  },
  {
    id: 'sidecar.doc.schema-drift',
    target: 'poseSidecar',
    dependency: 'sidecar-document',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      const wire = JSON.parse(json) as Record<string, unknown>;
      const mutation = pick(rng, [
        () => (wire['schemaVersion'] = 2),
        () => (wire['format'] = 'pickle.pose-sequence.v2'),
        () => (wire['coordinateSystem'] = 'pixels'),
        () => (wire['poseModelVersion'] = ''),
        () => (wire['video'] = { w: 0, h: 1080, fps: 30 }),
        () => (wire['video'] = null),
        () => (wire['frames'] = {}),
        () => delete wire['frames'],
      ]);
      mutation();
      const doc = JSON.stringify(wire);
      mockCapture.read = () => Promise.resolve(doc);
      const result = await loadReviewPoseSequence(refFor(doc));
      probe.check(result === null, 'schema drift must yield null');
    },
  },
  {
    id: 'sidecar.doc.corrupt-frames',
    target: 'poseSidecar',
    dependency: 'sidecar-document',
    mode: 'malformed',
    async run(rng, probe) {
      const { json } = validSidecar();
      const wire = JSON.parse(json) as {
        frames: Array<Record<string, unknown> | null>;
      };
      const at = int(rng, 1, wire.frames.length - 1);
      const frame = wire.frames[at]!;
      const mutation = pick(rng, [
        () => (frame['t'] = wire.frames[at - 1]!['t']),
        () => (frame['t'] = null),
        () => (frame['c'] = 'high'),
        () => (frame['i'] = 1.5),
        () => (frame['l'] = []),
        () => (frame['l'] = [{ n: 'head', x: null, y: 0.1, v: 1 }]),
        () => (frame['l'] = [{ n: '', x: 0.1, y: 0.1, v: 1 }]),
        () => (wire.frames[at] = null),
      ]);
      mutation();
      const doc = JSON.stringify(wire);
      mockCapture.read = () => Promise.resolve(doc);
      const result = await loadReviewPoseSequence(refFor(doc));
      probe.check(result === null, 'corrupt frame must yield null');
    },
  },
  {
    id: 'sidecar.doc.partial-frames',
    target: 'poseSidecar',
    dependency: 'sidecar-document',
    mode: 'partial',
    async run(rng, probe) {
      const { sequence, json } = validSidecar();
      const wire = JSON.parse(json) as { frames: unknown[] };
      const keep = int(rng, 0, wire.frames.length - 1);
      wire.frames = wire.frames.slice(0, keep);
      const doc = JSON.stringify(wire);
      mockCapture.read = () => Promise.resolve(doc);
      const result = await loadReviewPoseSequence(
        refFor(doc, { frameCount: sequence.frames.length }),
      );
      // A byte-identical shorter document is honest data, never padded.
      probe.check(
        result !== null && result.frames.length === keep,
        `partial doc of ${keep} frames returned ${
          result ? result.frames.length : 'null'
        }`,
      );
    },
  },
  {
    id: 'sidecar.read.slow',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'slow',
    async run(rng, probe) {
      useFakeClock();
      const { sequence, json } = validSidecar();
      const delayMs = int(rng, 1_000, 59_000);
      mockCapture.read = () =>
        new Promise(resolve => setTimeout(() => resolve(json), delayMs));
      const pending = loadReviewPoseSequence(refFor(json));
      await advance(delayMs - 500);
      const early = await settle(pending);
      probe.check(!early.settled, 'must not settle before the read completes');
      await advance(ONE_MINUTE_MS);
      const late = await settle(pending);
      probe.check(late.settled, `slow read (${delayMs}ms) never settled`);
      probe.check(
        late.value?.frames.length === sequence.frames.length,
        'slow read must still deliver the full sequence',
      );
    },
  },
  {
    id: 'sidecar.read.never-resolves',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'never-resolves',
    async run(_rng, probe) {
      useFakeClock();
      const { json } = validSidecar();
      mockCapture.read = () => new Promise(() => {});
      const pending = loadReviewPoseSequence(refFor(json));
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(pending);
      probe.check(
        outcome.settled,
        'loadReviewPoseSequence still pending after 60s of a hung native read (no timeout)',
      );
    },
  },
  {
    id: 'sidecar.read.timeout-rejection',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'timeout',
    async run(rng, probe) {
      useFakeClock();
      const { json } = validSidecar();
      const delayMs = int(rng, 1_000, 30_000);
      mockCapture.read = () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('file.timeout')), delayMs),
        );
      const pending = loadReviewPoseSequence(refFor(json));
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(pending);
      probe.check(outcome.settled, 'late rejection must settle the load');
      probe.check(
        outcome.settled && !('error' in outcome) && outcome.value === null,
        'late rejection must yield null',
      );
    },
  },
  {
    id: 'sidecar.platform.variants',
    target: 'poseSidecar',
    dependency: 'react-native:Platform',
    mode: 'malformed',
    async run(rng, probe) {
      const { sequence, json } = validSidecar();
      mockCapture.read = () => Promise.resolve(json);
      const rn = sharedReactNative;
      const os = pick(rng, ['ios', 'android', 'web', 'windows', '', 'IOS']);
      const seen: string[] = [];
      mockDomain.parse = (doc, producedBy) => {
        seen.push(`${producedBy.providerId}/${producedBy.runtime}`);
        return domain.parsePoseSequence(doc, producedBy);
      };
      const result = await withPlatform(rn, os, () =>
        loadReviewPoseSequence(refFor(json)),
      );
      probe.check(
        result?.frames.length === sequence.frames.length,
        `platform ${os} broke a valid load`,
      );
      const expected =
        os === 'android'
          ? 'pose.mediapipe/mediapipe'
          : 'pose.apple-vision/vision_framework';
      probe.check(
        seen[0] === expected,
        `platform ${os} labelled provenance ${seen[0] ?? 'none'}`,
      );
      probe.check(
        (result as PoseSequence | null)?.producedBy.executionTarget ===
          'on_device',
        'provenance must stay on_device',
      );
    },
  },
  {
    id: 'sidecar.concurrent.mixed',
    target: 'poseSidecar',
    dependency: 'camera:readCaptureArtifact',
    mode: 'partial',
    async run(rng, probe) {
      const { sequence, json } = validSidecar();
      const count = int(rng, 4, 24);
      const plan = Array.from({ length: count }, () =>
        pick(rng, ['ok', 'reject', 'garbage', 'truncate'] as const),
      );
      mockCapture.read = uri => {
        const index = Number(uri.replace(/.*#/, ''));
        switch (plan[index]) {
          case 'ok':
            return Promise.resolve(json);
          case 'reject':
            return Promise.reject(new Error('read failed'));
          case 'garbage':
            return Promise.resolve(42);
          case 'truncate':
            return Promise.resolve(json.slice(0, json.length >> 1));
          default:
            return Promise.reject(new Error('unplanned'));
        }
      };
      const results = await Promise.all(
        plan.map((_kind, index) =>
          loadReviewPoseSequence(
            refFor(json, { uri: `file:///captures/clip.pose.json#${index}` }),
          ),
        ),
      );
      results.forEach((result, index) => {
        if (plan[index] === 'ok') {
          probe.check(
            result?.frames.length === sequence.frames.length,
            `call ${index} (ok) lost its sequence under concurrency`,
          );
        } else {
          probe.check(
            result === null,
            `call ${index} (${plan[index]}) leaked a sequence from a sibling`,
          );
        }
      });
    },
  },
  {
    id: 'sidecar.doc.huge',
    target: 'poseSidecar',
    dependency: 'sidecar-document',
    mode: 'slow',
    async run(rng, probe) {
      const frames = int(rng, 3_000, 6_000);
      const wire = {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: 'apple-vision-bodypose-1',
        video: { w: 1080, h: 1920, fps: 60 },
        frames: Array.from({ length: frames }, (_v, i) => ({
          i,
          t: i * 16,
          c: 0.9,
          l: [{ n: 'right_wrist', x: 0.5, y: 0.5, v: 0.9 }],
        })),
      };
      const doc = JSON.stringify(wire);
      mockCapture.read = () => Promise.resolve(doc);
      const started = Date.now();
      const result = await loadReviewPoseSequence(refFor(doc));
      const elapsed = Date.now() - started;
      probe.check(result?.frames.length === frames, 'huge doc lost frames');
      probe.check(elapsed < 5_000, `huge doc took ${elapsed}ms`);
      probe.note(`${frames} frames parsed in ${elapsed}ms`);
    },
  },
];

// ── App Store review faults ─────────────────────────────────────────────────

async function reportOnce(
  harness: ReviewHarness,
  probe: Probe,
  label: string,
): Promise<void> {
  const outcome = await settle(
    harness.review.reportScoredAnalysisForReview({ delayMs: 0 }),
  );
  probe.check(outcome.settled, `${label}: report did not settle`);
  probe.check(
    !('error' in outcome),
    `${label}: report rejected — ${
      'error' in outcome ? describeError(outcome.error) : ''
    }`,
  );
}

const REVIEW_FAULTS: Fault[] = [
  {
    id: 'review.sqlite.open-throws',
    target: 'appStoreReview',
    dependency: 'sqlite:getDb',
    mode: 'throw',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      mockDb.getDbThrows = true;
      await reportOnce(h, probe, 'open-throws');
      probe.check(asks.mock.calls.length === 0, 'prompted without a record');
      checkPersisted(probe, h.review, foreign);
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
          openUrl: () => Promise.resolve(true),
        }),
      );
      probe.check(
        rate.settled && rate.value === 'store_page',
        'settings rate must still open the store page when sqlite is down',
      );
    },
  },
  {
    id: 'review.sqlite.select-rejects',
    target: 'appStoreReview',
    dependency: 'sqlite:execute(SELECT)',
    mode: 'reject',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      seedReviewState(h.review, { promptedCount: int(rng, 0, 5) });
      const before = mockDb.table.get(h.review.REVIEW_PROMPT_KV_KEY);
      mockDb.select = { kind: pick(rng, ['reject', 'throw'] as const) };
      await reportOnce(h, probe, 'select-rejects');
      probe.check(asks.mock.calls.length === 0, 'prompted on unreadable state');
      probe.check(
        mockDb.table.get(h.review.REVIEW_PROMPT_KV_KEY) === before,
        'state rewritten although it could not be read',
      );
      checkPersisted(probe, h.review, foreign);
    },
  },
  {
    id: 'review.sqlite.insert-rejects',
    target: 'appStoreReview',
    dependency: 'sqlite:execute(INSERT)',
    mode: 'reject',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const prompted = int(rng, 0, 5);
      seedReviewState(h.review, { promptedCount: prompted });
      mockDb.insert = { kind: pick(rng, ['reject', 'throw'] as const) };
      await reportOnce(h, probe, 'insert-rejects');
      probe.check(
        asks.mock.calls.length === 0,
        'prompted although the record could not be persisted (crash-replay risk)',
      );
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(
        state.promptedCount === prompted,
        `promptedCount moved ${prompted}→${state.promptedCount} on a failed write`,
      );
    },
  },
  {
    id: 'review.sqlite.result-malformed',
    target: 'appStoreReview',
    dependency: 'sqlite:execute(SELECT)',
    mode: 'malformed',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      mockDb.select = pick(rng, [
        { kind: 'resolve-undefined' },
        { kind: 'rows-undefined' },
        { kind: 'wrong-column' },
        { kind: 'value', value: 42 },
        { kind: 'value', value: true },
        { kind: 'value', value: { version: 1 } },
        { kind: 'value', value: '[1,2]' },
        { kind: 'value', value: '{"reviewedAtIso":' },
        { kind: 'value', value: '{"promptedCount":-3,"scoredAnalyses":"9"}' },
        { kind: 'value', value: '{"promptedCount":1e308}' },
        { kind: 'value', value: '{"reviewedAtIso":42}' },
      ] as const);
      await reportOnce(h, probe, `malformed ${JSON.stringify(mockDb.select)}`);
      probe.check(asks.mock.calls.length <= 1, 'prompted more than once');
      const wrote = mockDb.ops.includes('insert');
      probe.check(
        wrote === (asks.mock.calls.length === 1),
        'prompt without a persisted record (or record without a prompt)',
      );
      checkPersisted(probe, h.review, foreign);
    },
  },
  {
    id: 'review.sqlite.record-corrupt-after-review',
    target: 'appStoreReview',
    dependency: 'sqlite:kv-record',
    mode: 'partial',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const full = JSON.stringify({
        version: 1,
        scoredAnalyses: 4,
        promptedCount: 4,
        lastPromptedAtIso: '2026-09-01T10:00:00.000Z',
        reviewedAtIso: '2026-09-02T10:00:00.000Z',
      });
      const cut = full.slice(0, int(rng, 1, full.length - 1));
      mockDb.table.set(h.review.REVIEW_PROMPT_KV_KEY, cut);
      await reportOnce(h, probe, 'corrupt-record');
      // A torn write loses the reviewed flag: the module must recover to a
      // valid record and never crash; Apple throttles the re-ask.
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(
        state.promptedCount === 1 && state.scoredAnalyses === 1,
        `torn record recovered to ${JSON.stringify(state)}`,
      );
      probe.note(
        `torn record re-armed prompting (asked ${asks.mock.calls.length}×)`,
      );
    },
  },
  {
    id: 'review.sqlite.lost-write',
    target: 'appStoreReview',
    dependency: 'sqlite:execute(INSERT)',
    mode: 'malformed',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      mockDb.insert = { kind: 'lost-write' };
      const rounds = int(rng, 1, 6);
      for (let i = 0; i < rounds; i += 1) {
        await reportOnce(h, probe, `lost-write round ${i}`);
      }
      probe.check(
        asks.mock.calls.length === rounds,
        `lost writes changed ask count ${asks.mock.calls.length}/${rounds}`,
      );
      checkPersisted(probe, h.review, foreign);
    },
  },
  {
    id: 'review.sqlite.slow',
    target: 'appStoreReview',
    dependency: 'sqlite:execute',
    mode: 'slow',
    async run(rng, probe) {
      useFakeClock();
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const ms = int(rng, 500, 20_000);
      mockDb.select = { kind: 'slow', ms };
      mockDb.insert = { kind: 'slow', ms };
      const pending = h.review.reportScoredAnalysisForReview({ delayMs: 0 });
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(pending);
      probe.check(outcome.settled, `slow sqlite (${ms}ms) never settled`);
      probe.check(asks.mock.calls.length === 1, 'slow sqlite lost the ask');
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(state.promptedCount === 1, 'slow sqlite lost the record');
    },
  },
  {
    id: 'review.sqlite.select-hangs',
    target: 'appStoreReview',
    dependency: 'sqlite:execute(SELECT)',
    mode: 'never-resolves',
    async run(_rng, probe) {
      useFakeClock();
      const h = isolatedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      mockDb.select = { kind: 'hang' };
      const pending = h.review.reportScoredAnalysisForReview({ delayMs: 0 });
      await advance(ONE_MINUTE_MS);
      const report = await settle(pending);
      probe.note(
        report.settled
          ? 'report settled'
          : 'report pending after 60s (fire-and-forget)',
      );
      // The Settings row queues behind the hung read.
      mockDb.select = { kind: 'ok' };
      const opened = jest.fn(() => Promise.resolve(true));
      const rate = h.review.rateAppFromSettings({
        writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
        openUrl: opened,
      });
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(rate);
      probe.check(
        opened.mock.calls.length === 1,
        'store page not opened while sqlite hangs',
      );
      probe.check(
        outcome.settled,
        'rateAppFromSettings still pending 60s after the store page opened: one hung kv read wedges the shared review queue for the app lifetime',
      );
    },
  },
  {
    id: 'review.native.missing',
    target: 'appStoreReview',
    dependency: 'NativeModules.PickleStoreReview',
    mode: 'malformed',
    async run(rng, probe) {
      const h = sharedReviewModule();
      installNative(h.rn, pick(rng, ['missing', 'no-method'] as const));
      const foreign = seedForeignKeys(rng);
      const before = mockDb.table.get(h.review.REVIEW_PROMPT_KV_KEY);
      await reportOnce(h, probe, 'native-missing');
      probe.check(
        mockDb.table.get(h.review.REVIEW_PROMPT_KV_KEY) === before,
        'counted an ask with no StoreKit available',
      );
      checkPersisted(probe, h.review, foreign);
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: null,
          openUrl: () => Promise.resolve(true),
        }),
      );
      probe.check(
        rate.settled && rate.value === 'unavailable',
        `settings must report unavailable, got ${String(rate.value)}`,
      );
    },
  },
  {
    id: 'review.native.throws-sync',
    target: 'appStoreReview',
    dependency: 'NativeModules.PickleStoreReview.requestReview',
    mode: 'throw',
    async run(rng, probe) {
      const h = sharedReviewModule();
      installNative(h.rn, () => {
        throw pick(rng, [new Error('StoreKit unavailable'), 'nope', undefined]);
      });
      const foreign = seedForeignKeys(rng);
      await reportOnce(h, probe, 'native-throws');
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(state.promptedCount === 1, 'ask not recorded before prompt');
      const prompt = await settle(h.review.requestNativeReviewPrompt());
      probe.check(
        prompt.settled && prompt.value === false,
        'requestNativeReviewPrompt must resolve false on a throwing bridge',
      );
    },
  },
  {
    id: 'review.native.rejects',
    target: 'appStoreReview',
    dependency: 'NativeModules.PickleStoreReview.requestReview',
    mode: 'reject',
    async run(rng, probe) {
      const h = sharedReviewModule();
      installNative(h.rn, () => Promise.reject(pick(rng, GARBAGE_VALUES)));
      const foreign = seedForeignKeys(rng);
      await reportOnce(h, probe, 'native-rejects');
      checkPersisted(probe, h.review, foreign);
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: null,
          openUrl: () => Promise.resolve(true),
        }),
      );
      probe.check(
        rate.settled && rate.value === 'unavailable',
        'a rejecting bridge must surface as unavailable (visible notice)',
      );
    },
  },
  {
    id: 'review.native.resolves-garbage',
    target: 'appStoreReview',
    dependency: 'NativeModules.PickleStoreReview.requestReview',
    mode: 'malformed',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const value = pick(rng, ['yes', 0, 1, null, undefined, {}, [], 'false']);
      installNative(h.rn, () => Promise.resolve(value));
      const foreign = seedForeignKeys(rng);
      await reportOnce(h, probe, 'native-garbage');
      checkPersisted(probe, h.review, foreign);
      const prompt = await settle(h.review.requestNativeReviewPrompt());
      probe.check(
        prompt.settled && typeof prompt.value === 'boolean',
        `bridge value ${JSON.stringify(value)} leaked as ${String(prompt.value)}`,
      );
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: null,
          openUrl: () => Promise.resolve(true),
        }),
      );
      probe.check(
        rate.settled &&
          (rate.value === 'native_prompt' || rate.value === 'unavailable'),
        `settings outcome ${String(rate.value)} not in the contract`,
      );
      if (!value) {
        probe.check(
          rate.value === 'unavailable',
          `falsy bridge value ${JSON.stringify(value)} reported as success`,
        );
      }
    },
  },
  {
    id: 'review.native.slow',
    target: 'appStoreReview',
    dependency: 'NativeModules.PickleStoreReview.requestReview',
    mode: 'slow',
    async run(rng, probe) {
      useFakeClock();
      const h = sharedReviewModule();
      const ms = int(rng, 1_000, 30_000);
      installNative(
        h.rn,
        () => new Promise(resolve => setTimeout(() => resolve(true), ms)),
      );
      const foreign = seedForeignKeys(rng);
      const pending = h.review.reportScoredAnalysisForReview({
        delayMs: int(rng, 0, 5_000),
      });
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(pending);
      probe.check(outcome.settled, `slow StoreKit (${ms}ms) never settled`);
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(state.promptedCount === 1, 'slow StoreKit lost the record');
    },
  },
  {
    id: 'review.native.never-resolves',
    target: 'appStoreReview',
    dependency: 'NativeModules.PickleStoreReview.requestReview',
    mode: 'never-resolves',
    async run(_rng, probe) {
      useFakeClock();
      const h = isolatedReviewModule();
      installNative(h.rn, () => new Promise(() => {}));
      const pending = h.review.reportScoredAnalysisForReview({ delayMs: 0 });
      await advance(ONE_MINUTE_MS);
      const report = await settle(pending);
      probe.note(
        report.settled ? 'report settled' : 'report pending after 60s',
      );
      const state = checkPersisted(probe, h.review, new Map());
      probe.check(state.promptedCount === 1, 'record missing before the hang');
      const marked = h.review.markStoreReviewCompleted();
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(marked);
      probe.check(
        outcome.settled,
        'markStoreReviewCompleted still pending 60s later: a hung StoreKit bridge wedges the shared review queue',
      );
    },
  },
  {
    id: 'review.platform.android',
    target: 'appStoreReview',
    dependency: 'react-native:Platform',
    mode: 'malformed',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const os = pick(rng, ['android', 'web', 'windows', 'macos', '']);
      await withPlatform(h.rn, os, async () => {
        await reportOnce(h, probe, `platform ${os}`);
        probe.check(
          asks.mock.calls.length === 0,
          `StoreKit asked on platform ${os}`,
        );
        probe.check(
          !mockDb.ops.includes('insert'),
          `counted an ask on platform ${os}`,
        );
        const rate = await settle(
          h.review.rateAppFromSettings({
            writeReviewUrl: null,
            openUrl: () => Promise.resolve(true),
          }),
        );
        probe.check(
          rate.settled && rate.value === 'unavailable',
          `platform ${os} without a store url must be unavailable`,
        );
      });
      checkPersisted(probe, h.review, foreign);
    },
  },
  {
    id: 'review.clock.invalid-date',
    target: 'appStoreReview',
    dependency: 'clock:Date#toISOString',
    mode: 'throw',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const prompted = int(rng, 0, 4);
      seedReviewState(h.review, { promptedCount: prompted });
      const spy = jest
        .spyOn(Date.prototype, 'toISOString')
        .mockImplementation(() => {
          throw new RangeError('Invalid time value');
        });
      try {
        await reportOnce(h, probe, 'invalid-date');
        const rate = await settle(
          h.review.rateAppFromSettings({
            writeReviewUrl:
              'https://apps.apple.com/app/id1?action=write-review',
            openUrl: () => Promise.resolve(true),
          }),
        );
        probe.check(
          rate.settled && rate.value === 'store_page',
          'settings rate must not depend on the clock',
        );
      } finally {
        spy.mockRestore();
      }
      probe.check(asks.mock.calls.length === 0, 'prompted without a record');
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(
        state.promptedCount === prompted,
        'promptedCount changed although the record could not be built',
      );
    },
  },
  {
    id: 'review.clock.jumps',
    target: 'appStoreReview',
    dependency: 'clock:system time',
    mode: 'malformed',
    async run(rng, probe) {
      useFakeDate();
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const times = [
        Date.UTC(2026, 8, 1),
        Date.UTC(1970, 0, 1),
        Date.UTC(2099, 11, 31),
        Date.UTC(2026, 8, 1) - int(rng, 1, 1e9),
      ];
      for (const t of shuffled(rng, times)) {
        jest.setSystemTime(t);
        await reportOnce(h, probe, `clock ${t}`);
      }
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(
        state.promptedCount === times.length,
        `clock jumps lost asks: ${state.promptedCount}/${times.length}`,
      );
    },
  },
  {
    id: 'review.linking.rejects',
    target: 'appStoreReview',
    dependency: 'react-native:Linking.openURL',
    mode: 'reject',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const failure = pick(rng, [
        () => Promise.reject(new Error('Unable to open URL')),
        () => {
          throw new Error('Linking unavailable');
        },
        () => Promise.reject(undefined),
      ]);
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
          openUrl: failure,
        }),
      );
      probe.check(
        rate.settled && rate.value === 'native_prompt',
        `store page failure must fall back to StoreKit, got ${String(rate.value)}`,
      );
      probe.check(
        asks.mock.calls.length === 1,
        'fallback did not ask StoreKit',
      );
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(
        state.reviewedAtIso === null,
        'marked reviewed although the store page never opened (fake success)',
      );
    },
  },
  {
    id: 'review.linking.rejects-and-native-down',
    target: 'appStoreReview',
    dependency: 'react-native:Linking.openURL + StoreKit',
    mode: 'reject',
    async run(rng, probe) {
      const h = sharedReviewModule();
      installNative(
        h.rn,
        pick(rng, [
          'missing' as const,
          () => Promise.reject(new Error('no scene')),
          () => Promise.resolve(false),
        ]),
      );
      const foreign = seedForeignKeys(rng);
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
          openUrl: () => Promise.reject(new Error('Unable to open URL')),
        }),
      );
      probe.check(
        rate.settled && rate.value === 'unavailable',
        `both paths down must be unavailable (visible notice), got ${String(rate.value)}`,
      );
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(state.reviewedAtIso === null, 'fake reviewed flag');
    },
  },
  {
    id: 'review.linking.slow',
    target: 'appStoreReview',
    dependency: 'react-native:Linking.openURL',
    mode: 'slow',
    async run(rng, probe) {
      useFakeClock();
      const h = sharedReviewModule();
      installNative(h.rn, () => Promise.resolve(true));
      const foreign = seedForeignKeys(rng);
      const ms = int(rng, 1_000, 30_000);
      const rate = h.review.rateAppFromSettings({
        writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
        openUrl: () =>
          new Promise(resolve => setTimeout(() => resolve(true), ms)),
      });
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(rate);
      probe.check(
        outcome.settled && outcome.value === 'store_page',
        `slow Linking (${ms}ms) did not resolve store_page`,
      );
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(state.reviewedAtIso !== null, 'store visit not recorded');
    },
  },
  {
    id: 'review.linking.never-resolves',
    target: 'appStoreReview',
    dependency: 'react-native:Linking.openURL',
    mode: 'never-resolves',
    async run(_rng, probe) {
      useFakeClock();
      const h = isolatedReviewModule();
      installNative(h.rn, () => Promise.resolve(true));
      const rate = h.review.rateAppFromSettings({
        writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
        openUrl: () => new Promise(() => {}),
      });
      await advance(ONE_MINUTE_MS);
      const outcome = await settle(rate);
      probe.note(
        outcome.settled
          ? `settled ${String(outcome.value)}`
          : 'rateAppFromSettings pending after 60s (Linking never settled; Settings shows no busy state)',
      );
      const state = checkPersisted(probe, h.review, new Map());
      probe.check(
        state.reviewedAtIso === null,
        'reviewed flag set while the store page never confirmed',
      );
      // The queue itself is untouched by a hung Linking call.
      mockDb.reset();
      const report = h.review.reportScoredAnalysisForReview({ delayMs: 0 });
      await advance(1_000);
      const settled = await settle(report);
      probe.check(
        settled.settled,
        'a hung Linking call wedged the review queue',
      );
    },
  },
  {
    id: 'review.config.url-variants',
    target: 'appStoreReview',
    dependency: 'runtimeConfig:appStoreWriteReviewUrl',
    mode: 'malformed',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const url = pick(rng, [null, '', 'not a url', 'itms-apps://x', '   ']);
      const opened: string[] = [];
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: url,
          openUrl: target => {
            opened.push(target);
            return Promise.resolve(true);
          },
        }),
      );
      probe.check(rate.settled, 'settings rate did not settle');
      if (!url) {
        probe.check(
          opened.length === 0,
          `opened falsy url ${JSON.stringify(url)}`,
        );
        probe.check(
          rate.value === 'native_prompt',
          `no url must ask StoreKit, got ${String(rate.value)}`,
        );
      } else {
        probe.check(
          rate.value === 'store_page' || rate.value === 'native_prompt',
          `url ${JSON.stringify(url)} produced ${String(rate.value)}`,
        );
      }
      checkPersisted(probe, h.review, foreign);
    },
  },
  {
    id: 'review.mark.kv-down',
    target: 'appStoreReview',
    dependency: 'sqlite:execute',
    mode: 'reject',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      mockDb.insert = { kind: pick(rng, ['reject', 'throw'] as const) };
      const rate = await settle(
        h.review.rateAppFromSettings({
          writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
          openUrl: () => Promise.resolve(true),
        }),
      );
      probe.check(
        rate.settled && rate.value === 'store_page',
        'store page opened must report store_page even when the mark fails',
      );
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(
        state.reviewedAtIso === null,
        'reviewed persisted through a failed write',
      );
      // Recovery path: the next Settings tap marks it once kv is back.
      mockDb.insert = { kind: 'ok' };
      await h.review.rateAppFromSettings({
        writeReviewUrl: 'https://apps.apple.com/app/id1?action=write-review',
        openUrl: () => Promise.resolve(true),
      });
      const recovered = checkPersisted(probe, h.review, foreign);
      probe.check(recovered.reviewedAtIso !== null, 'mark did not recover');
      await reportOnce(h, probe, 'after-mark');
      probe.check(
        asks.mock.calls.length === 0,
        'asked after the user reviewed',
      );
    },
  },
  {
    id: 'review.concurrency.interleaved-faults',
    target: 'appStoreReview',
    dependency: 'sqlite:execute (per-call faults)',
    mode: 'partial',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const count = int(rng, 3, 30);
      // Per-call fault plan, consumed in queue order (the module serializes).
      const plan = Array.from({ length: count }, () =>
        pick(rng, ['ok', 'ok', 'ok', 'select-fail', 'insert-fail'] as const),
      );
      let call = 0;
      const originalExecute = mockDb.execute.bind(mockDb);
      mockDb.execute = (sql, params) => {
        const op: SqlOp = sql.startsWith('SELECT') ? 'select' : 'insert';
        const step = plan[call];
        if (op === 'select') {
          if (step === 'select-fail') {
            call += 1;
            return Promise.reject(new Error('select failed'));
          }
        } else {
          call += 1;
          if (step === 'insert-fail') {
            return Promise.reject(new Error('insert failed'));
          }
        }
        return originalExecute(sql, params);
      };
      try {
        const outcomes = await settleAll(
          plan.map(() =>
            h.review.reportScoredAnalysisForReview({ delayMs: 0 }),
          ),
        );
        outcomes.forEach((outcome, index) => {
          probe.check(outcome.settled, `report ${index} did not settle`);
          probe.check(!('error' in outcome), `report ${index} rejected`);
        });
        const expected = plan.filter(step => step === 'ok').length;
        const state = checkPersisted(probe, h.review, foreign);
        probe.check(
          state.promptedCount === expected,
          `promptedCount ${state.promptedCount} != successful runs ${expected} (plan ${plan.join(',')})`,
        );
        probe.check(
          asks.mock.calls.length === expected,
          `asks ${asks.mock.calls.length} != ${expected}`,
        );
      } finally {
        mockDb.execute = originalExecute;
      }
    },
  },
  {
    id: 'review.concurrency.mark-mid-stream',
    target: 'appStoreReview',
    dependency: 'review queue',
    mode: 'partial',
    async run(rng, probe) {
      const h = sharedReviewModule();
      const asks = jest.fn(() => Promise.resolve(true));
      installNative(h.rn, asks);
      const foreign = seedForeignKeys(rng);
      const before = int(rng, 0, 6);
      const after = int(rng, 1, 6);
      const work: Promise<unknown>[] = [];
      for (let i = 0; i < before; i += 1) {
        work.push(h.review.reportScoredAnalysisForReview({ delayMs: 0 }));
      }
      work.push(h.review.markStoreReviewCompleted());
      for (let i = 0; i < after; i += 1) {
        work.push(h.review.reportScoredAnalysisForReview({ delayMs: 0 }));
      }
      const outcomes = await settleAll(work);
      outcomes.forEach((outcome, index) => {
        probe.check(outcome.settled, `queued op ${index} did not settle`);
      });
      const state = checkPersisted(probe, h.review, foreign);
      probe.check(
        asks.mock.calls.length === before,
        `asked ${asks.mock.calls.length}× but only ${before} preceded the review`,
      );
      probe.check(
        state.promptedCount === before && state.reviewedAtIso !== null,
        `state after mark: ${JSON.stringify(state)}`,
      );
    },
  },
];

// ── Review model / geometry / drills faults (hostile persisted records) ─────

function hostileAnalysis(rng: Rng, mutate: (a: Loose, rng: Rng) => void) {
  const analysis = cloneAnalysis();
  mutate(loose(analysis), rng);
  return analysis;
}

const MODEL_FAULTS: Fault[] = [
  {
    id: 'model.checkpoints.not-array',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        a['checkpoints'] = pick(rng, GARBAGE_VALUES);
      });
      const script = runReviewModel(probe, analysis, fullBodySequence());
      probe.check(
        script !== null && script.stops.length >= 1,
        'no stops: the contact fallback stop must survive missing checkpoints',
      );
      probe.check(
        drillFocusFromAnalysis(analysis) === null,
        'invented a drill focus without checkpoints',
      );
    },
  },
  {
    id: 'model.checkpoints.garbage-entries',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as unknown[];
        const count = int(rng, 1, 6);
        for (let i = 0; i < count; i += 1) {
          list.splice(int(rng, 0, list.length), 0, pick(rng, GARBAGE_VALUES));
        }
      });
      runReviewModel(probe, analysis, fullBodySequence());
    },
  },
  {
    id: 'model.checkpoints.unknown-keys',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        for (const cp of list) {
          if (rng() < 0.4) {
            cp['key'] = pick(rng, [
              ...PROTO_KEYS,
              'contact_height',
              '',
              42,
              null,
              'CONTACT_POSITION',
            ]);
          }
        }
      });
      const script = runReviewModel(probe, analysis, fullBodySequence());
      if (script) {
        for (const stop of script.stops) {
          for (const cp of stop.checkpoints) {
            probe.check(
              (CHECKPOINTS as readonly string[]).includes(cp.key),
              `unknown key ${String(cp.key)} reached a stop`,
            );
          }
        }
      }
    },
  },
  {
    id: 'model.checkpoints.duplicates',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        const copies = int(rng, 1, 4);
        for (let i = 0; i < copies; i += 1) {
          const dup = { ...pick(rng, list), score: int(rng, 0, 100) };
          list.splice(int(rng, 0, list.length), 0, dup);
        }
      });
      const script = runReviewModel(probe, analysis, fullBodySequence());
      if (script) {
        const seen = new Set<string>();
        for (const stop of script.stops) {
          for (const cp of stop.checkpoints) {
            probe.check(!seen.has(cp.key), `checkpoint ${cp.key} duplicated`);
            seen.add(cp.key);
          }
        }
      }
    },
  },
  {
    id: 'model.checkpoints.score-non-finite',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        for (const cp of list) {
          if (rng() < 0.5) {
            cp['score'] = pick(rng, [
              ...NON_FINITE,
              '85',
              null,
              undefined,
              -5,
              250,
            ]);
          }
        }
      });
      const script = runReviewModel(probe, analysis, fullBodySequence());
      if (script?.weakest) {
        probe.check(Number.isFinite(script.weakest.score), 'weakest NaN');
      }
    },
  },
  {
    id: 'model.checkpoints.band-garbage',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        for (const cp of list) {
          if (rng() < 0.5) {
            cp['band'] = pick(rng, [...PROTO_KEYS, 'purple', 42, null, '']);
          }
        }
      });
      runReviewModel(probe, analysis, fullBodySequence());
    },
  },
  {
    id: 'model.checkpoints.direction-proto-key',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const direction = pick(rng, PROTO_KEYS);
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        const faults = list.filter(
          cp => cp['band'] !== 'green' && cp['band'] !== 'unscored',
        );
        pick(rng, faults)['direction'] = direction;
      });
      runReviewModel(probe, analysis, fullBodySequence());
      probe.note(`direction=${direction}`);
    },
  },
  {
    id: 'model.checkpoints.direction-unknown',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        for (const cp of list) {
          if (rng() < 0.5) {
            cp['direction'] = pick(rng, [
              'sideways',
              '',
              42,
              null,
              undefined,
              'LATE',
            ]);
          }
        }
      });
      runReviewModel(probe, analysis, fullBodySequence());
    },
  },
  {
    id: 'model.checkpoints.applicable-garbage',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        for (const cp of list) {
          if (rng() < 0.5)
            cp['applicable'] = pick(rng, [0, 'no', null, undefined, false]);
        }
      });
      const script = runReviewModel(probe, analysis, fullBodySequence());
      if (script) {
        for (const stop of script.stops) {
          for (const cp of stop.checkpoints) {
            const raw = analysis.checkpoints.find(c => c.key === cp.key);
            probe.check(
              raw?.applicable !== false,
              `inapplicable checkpoint ${cp.key} reached a stop`,
            );
          }
        }
      }
    },
  },
  {
    id: 'model.phases.malformed',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        const mutation = pick(rng, [
          () => (a['phases'] = pick(rng, GARBAGE_VALUES)),
          () => (a['phases'] = []),
          () => {
            const list = a['phases'] as Record<string, unknown>[];
            list.push(null as unknown as Record<string, unknown>, {
              key: 'contact',
              startMs: 5,
              endMs: 6,
            });
          },
          () => {
            for (const span of a['phases'] as Record<string, unknown>[]) {
              if (rng() < 0.5) span['startMs'] = pick(rng, NON_FINITE);
              if (rng() < 0.5) span['endMs'] = pick(rng, [...NON_FINITE, -1]);
              if (rng() < 0.5)
                span['representativeMs'] = pick(rng, [...NON_FINITE, 1e12]);
            }
          },
          () => {
            for (const span of a['phases'] as Record<string, unknown>[]) {
              const s = span['startMs'] as number;
              span['startMs'] = span['endMs'];
              span['endMs'] = s;
            }
          },
          () => {
            for (const span of a['phases'] as Record<string, unknown>[]) {
              if (rng() < 0.5)
                span['key'] = pick(rng, [...PROTO_KEYS, 'windup', 7]);
            }
          },
        ]);
        mutation();
      });
      const script = runReviewModel(probe, analysis, fullBodySequence());
      probe.check(
        script !== null && script.stops.length >= 1,
        'a scored record must always produce at least the contact stop',
      );
    },
  },
  {
    id: 'model.timestamps.malformed',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        a['timestamps'] = pick(rng, [
          null,
          undefined,
          {},
          { startMs: Number.NaN, contactMs: Number.NaN, endMs: Number.NaN },
          { startMs: 100, contactMs: 50, endMs: 10 },
          { startMs: '0', contactMs: '1900', endMs: '3200' },
          { startMs: -1e15, contactMs: 0, endMs: 1e15 },
        ]);
        if (rng() < 0.5) a['phases'] = [];
      });
      runReviewModel(probe, analysis, fullBodySequence());
    },
  },
  {
    id: 'model.shotType.proto-key',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const shotType = pick(rng, PROTO_KEYS);
      const analysis = hostileAnalysis(rng, a => {
        a['shotType'] = shotType;
      });
      runReviewModel(probe, analysis, fullBodySequence());
      probe.note(`shotType=${shotType}`);
    },
  },
  {
    id: 'model.shotType.unknown',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        a['shotType'] = pick(rng, [
          'mystery_shot',
          '',
          null,
          undefined,
          42,
          'DINK',
        ]);
      });
      runReviewModel(probe, analysis, fullBodySequence());
      const focus = drillFocusFromAnalysis(analysis);
      if (focus) {
        probe.check(
          focus.family === 'global',
          `unknown shot got family ${focus.family}`,
        );
      }
    },
  },
  {
    id: 'model.handedness.garbage',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        a['handedness'] = pick(rng, ['both', 'LEFT', '', null, undefined, 1]);
      });
      // No wrists measured: handedness alone decides.
      const headOnly: ReviewPoseSequence = {
        frames: [frameAt(1900, { head: { x: 0.5, y: 0.2 } })],
      };
      const script = runReviewModel(probe, analysis, headOnly);
      probe.check(
        script?.dominant === 'right',
        'garbage handedness must default right',
      );
    },
  },
  {
    id: 'model.priorityFix.garbage',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        a['priorityFix'] = pick(rng, [
          null,
          undefined,
          {},
          { checkpoint: 'swing_length' },
          { checkpoint: pick(rng, PROTO_KEYS) },
          { checkpoint: 42 },
          'contact_position',
        ]);
        if (rng() < 0.5) {
          // Only green checkpoints remain scored: no fix may be invented.
          const list = a['checkpoints'] as Record<string, unknown>[];
          for (const cp of list) {
            if (cp['band'] !== 'green') cp['score'] = null;
          }
        }
      });
      runReviewModel(probe, analysis, fullBodySequence());
      const fixes = fixList(analysis);
      const focus = drillFocusFromAnalysis(analysis);
      if (fixes.length === 0) {
        const priority = (
          analysis.priorityFix as { checkpoint?: unknown } | null
        )?.checkpoint;
        const named = analysis.checkpoints.find(
          cp => cp && cp.key === priority && Number.isFinite(cp.score),
        );
        probe.check(
          (focus === null) === !named,
          `focus ${JSON.stringify(focus)} does not match the record`,
        );
      }
    },
  },
  {
    id: 'model.record.everything-hostile',
    target: 'formReviewModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const analysis = hostileAnalysis(rng, a => {
        for (const field of shuffled(rng, Object.keys(a)).slice(
          0,
          int(rng, 1, 6),
        )) {
          if (field === 'id') continue;
          a[field] = pick(rng, GARBAGE_VALUES);
        }
      });
      const sequence = pick(rng, [fullBodySequence(), null, { frames: [] }]);
      runReviewModel(probe, analysis, sequence);
    },
  },
  {
    id: 'pose.frames.malformed',
    target: 'formReviewModel',
    dependency: 'pose-sequence',
    mode: 'malformed',
    run(rng, probe) {
      const sequence = pick(rng, [
        { frames: pick(rng, GARBAGE_VALUES) },
        { frames: [null, undefined, 42, {}] },
        { frames: [{ timestampMs: Number.NaN, landmarks: [], confidence: 1 }] },
        { frames: [{ timestampMs: 1900, landmarks: null, confidence: 1 }] },
        {
          frames: [{ timestampMs: 1900, landmarks: [null, 5], confidence: 1 }],
        },
        null,
        {},
      ]) as unknown as ReviewPoseSequence | null;
      const analysis = cloneAnalysis();
      runReviewModel(probe, analysis, sequence);
      checkPoseLookups(probe, sequence, [0, 1900, Number.NaN, ...NON_FINITE]);
    },
  },
  {
    id: 'pose.landmarks.non-finite',
    target: 'formReviewModel',
    dependency: 'pose-sequence',
    mode: 'malformed',
    run(rng, probe) {
      const sequence = fullBodySequence();
      const frames = sequence.frames as ReviewPoseFrame[];
      for (const frame of frames) {
        for (const mark of frame.landmarks as unknown as Array<{
          x: number;
          y: number;
          visibility: number;
        }>) {
          if (rng() < 0.3) mark.x = pick(rng, NON_FINITE);
          if (rng() < 0.3) mark.y = pick(rng, NON_FINITE);
          if (rng() < 0.3) mark.visibility = pick(rng, [...NON_FINITE, -1, 0]);
        }
      }
      const script = runReviewModel(probe, cloneAnalysis(), sequence);
      probe.check(script !== null, 'script null');
    },
  },
  {
    id: 'pose.timestamps.non-monotonic',
    target: 'formReviewModel',
    dependency: 'pose-sequence',
    mode: 'malformed',
    run(rng, probe) {
      const sequence = fullBodySequence();
      const frames = shuffled(rng, sequence.frames as ReviewPoseFrame[]);
      if (rng() < 0.5) frames.push({ ...frames[0]! });
      const hostile: ReviewPoseSequence = { frames, video: sequence.video };
      runReviewModel(probe, cloneAnalysis(), hostile);
      const times = Array.from({ length: 12 }, () => int(rng, -500, 4_000));
      checkPoseLookups(probe, hostile, times);
    },
  },
  {
    id: 'pose.lookup.time-non-finite',
    target: 'formReviewModel',
    dependency: 'pose-sequence',
    mode: 'malformed',
    run(rng, probe) {
      const sequence = fullBodySequence(int(rng, 10, 200));
      checkPoseLookups(probe, sequence, [
        ...NON_FINITE,
        -1e18,
        1e18,
        Number.MIN_VALUE,
        Number.MAX_SAFE_INTEGER,
      ]);
      for (const t of [-1e18, 1e18]) {
        probe.check(
          poseFrameAt(sequence, t) === null,
          `frame invented at ${t}`,
        );
      }
    },
  },
  {
    id: 'pose.video.malformed',
    target: 'formReviewModel',
    dependency: 'pose-sequence',
    mode: 'malformed',
    run(rng, probe) {
      const video = pick(rng, [
        { width: 0, height: 1920, fps: 30 },
        { width: Number.NaN, height: 1920, fps: 30 },
        { width: 1080, height: -1, fps: 30 },
        { width: 1080, height: 1920, fps: Number.NaN },
        { w: 1080, h: 1920, fps: 30 },
        { w: 0, h: 0, fps: 0 },
        null,
        'big',
      ]) as unknown as ReviewPoseSequence['video'];
      const sequence: ReviewPoseSequence = { ...fullBodySequence(), video };
      checkPoseLookups(probe, sequence, [1900]);
      runReviewModel(probe, cloneAnalysis(), sequence);
    },
  },
  {
    id: 'pose.frames.huge',
    target: 'formReviewModel',
    dependency: 'pose-sequence',
    mode: 'slow',
    run(rng, probe) {
      const count = int(rng, 20_000, 40_000);
      const frames: ReviewPoseFrame[] = [];
      for (let i = 0; i < count; i += 1) {
        frames.push(
          frameAt(i * 8, {
            right_wrist: { x: (i % 100) / 100, y: 0.5 },
            left_wrist: { x: 0.4, y: 0.5 },
            left_hip: { x: 0.46, y: 0.55 },
            right_hip: { x: 0.54, y: 0.55 },
          }),
        );
      }
      const sequence: ReviewPoseSequence = { frames };
      const started = Date.now();
      runReviewModel(probe, cloneAnalysis(), sequence);
      for (let i = 0; i < 200; i += 1) {
        const t = int(rng, 0, count * 8);
        const frame = poseFrameAt(sequence, t);
        probe.check(
          frame !== null && Math.abs(frame.timestampMs - t) <= 4,
          `nearest lookup wrong at ${t}: ${frame?.timestampMs ?? 'null'}`,
        );
      }
      const elapsed = Date.now() - started;
      probe.check(elapsed < 5_000, `huge sequence took ${elapsed}ms`);
      probe.note(`${count} frames, ${elapsed}ms`);
    },
  },
  {
    id: 'geometry.containRect.degenerate',
    target: 'formReviewGeometry',
    dependency: 'layout-metrics',
    mode: 'malformed',
    run(rng, probe) {
      const dims = [
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1e-9,
        1e9,
        390,
      ];
      for (let i = 0; i < 10; i += 1) {
        const stage = { width: pick(rng, dims), height: pick(rng, dims) };
        const video = { width: pick(rng, dims), height: pick(rng, dims) };
        const rect = neverThrows(probe, 'containRect', () =>
          containRect(stage, video),
        );
        if (rect) {
          const finite =
            Number.isFinite(rect.x) &&
            Number.isFinite(rect.y) &&
            Number.isFinite(rect.width) &&
            Number.isFinite(rect.height);
          const stageOk =
            Number.isFinite(stage.width) &&
            Number.isFinite(stage.height) &&
            stage.width > 0 &&
            stage.height > 0;
          probe.check(
            !stageOk || (finite && rect.width >= 0 && rect.height >= 0),
            `containRect(${JSON.stringify(stage)},${JSON.stringify(video)}) → ${JSON.stringify(rect)}`,
          );
          const point = neverThrows(probe, 'stagePoint', () =>
            stagePoint(rect, { x: rng(), y: rng() }),
          );
          probe.check(
            !stageOk ||
              (point !== null &&
                Number.isFinite(point.x) &&
                Number.isFinite(point.y)),
            'stagePoint produced a non-finite point for a finite stage',
          );
        }
      }
    },
  },
  {
    id: 'geometry.heat.non-finite',
    target: 'formReviewGeometry',
    dependency: 'joint-heat',
    mode: 'malformed',
    run(rng, probe) {
      for (const heat of [...NON_FINITE, -5, 5, rng() * 3 - 1, 0, 1]) {
        const rgb = neverThrows(probe, `heatRampColor(${heat})`, () =>
          heatRampColor(heat),
        );
        if (rgb) {
          probe.check(
            rgb.every(c => Number.isFinite(c) && c >= 0 && c <= 255),
            `heatRampColor(${heat}) → ${rgb.join(',')}`,
          );
        }
        for (const fn of [heatTint, faultTint]) {
          const tint = neverThrows(probe, `${fn.name}(${heat})`, () =>
            fn(heat),
          );
          probe.check(
            typeof tint === 'string' &&
              /^(#[0-9A-Fa-f]{6}|rgba?\(\d+,\d+,\d+(,[0-9.]+)?\))$/.test(tint),
            `${fn.name}(${heat}) → ${String(tint)}`,
          );
        }
      }
    },
  },
  {
    id: 'geometry.torsoUnit.degenerate',
    target: 'formReviewGeometry',
    dependency: 'pose-landmarks',
    mode: 'malformed',
    run(rng, probe) {
      const bad = pick(rng, NON_FINITE);
      const cases = [
        {},
        { left_shoulder: { x: bad, y: 0.3 }, left_hip: { x: 0.4, y: 0.6 } },
        { left_shoulder: { x: 0.4, y: 0.3 }, right_hip: { x: 0.4, y: 0.3 } },
        { right_shoulder: { x: 0.5, y: 0.3 }, right_hip: { x: 0.5, y: bad } },
      ];
      for (const points of cases) {
        const unit = neverThrows(probe, 'torsoUnit', () => torsoUnit(points));
        probe.check(
          unit === TORSO_UNIT_FALLBACK,
          `torsoUnit(${JSON.stringify(points)}) → ${String(unit)}`,
        );
      }
    },
  },
  {
    id: 'geometry.stops.non-finite-times',
    target: 'formReviewGeometry',
    dependency: 'review-script',
    mode: 'malformed',
    run(rng, probe) {
      const script = buildFormReviewScript(cloneAnalysis(), fullBodySequence());
      const stops = script.stops.map(stop => ({ ...stop })) as ReviewStop[];
      for (const stop of stops) {
        if (rng() < 0.4) stop.atMs = pick(rng, NON_FINITE);
        if (rng() < 0.3) stop.startMs = pick(rng, NON_FINITE);
        if (rng() < 0.3) stop.endMs = pick(rng, NON_FINITE);
      }
      const times = [...NON_FINITE, -1, 0, 1900, 1e9, int(rng, 0, 3200)];
      for (const t of times) {
        const current = neverThrows(probe, `currentStop(${t})`, () =>
          currentStop(stops, t),
        );
        probe.check(
          current === null || stops.includes(current),
          `currentStop(${t}) returned a foreign stop`,
        );
        const pause = neverThrows(probe, `nextAutoPause(${t})`, () =>
          nextAutoPause(stops, t - 40, t, new Set()),
        );
        probe.check(
          pause === null || stops.includes(pause),
          `nextAutoPause(${t}) returned a foreign stop`,
        );
        if (pause && Number.isFinite(pause.atMs)) {
          probe.check(
            pause.atMs > t - 40 && pause.atMs <= t,
            `nextAutoPause fired for ${pause.atMs} outside (${t - 40},${t}]`,
          );
        }
      }
      probe.check(currentStop([], 1900) === null, 'currentStop([]) not null');
      probe.check(
        nextAutoPause([], 0, 1900, new Set()) === null,
        'nextAutoPause([]) not null',
      );
    },
  },
  {
    id: 'geometry.arrow.garbage-direction',
    target: 'formReviewGeometry',
    dependency: 'review-script',
    mode: 'malformed',
    run(rng, probe) {
      const direction = pick(rng, [
        'up',
        'down',
        'forward',
        'back',
        'steadier',
        'sideways',
        '',
        undefined,
      ]) as Parameters<typeof arrowVector>[0];
      const facing = pick(rng, [1, -1, 0, Number.NaN]) as 1 | -1;
      const joint = { x: pick(rng, [0.5, Number.NaN, 2]), y: 0.5 };
      const vector = neverThrows(probe, 'arrowVector', () =>
        arrowVector(direction, facing, joint, pick(rng, [0.5, Number.NaN])),
      );
      if (vector && Number.isFinite(joint.x) && Math.abs(facing) === 1) {
        probe.check(
          Number.isFinite(vector.dx) && Number.isFinite(vector.dy),
          `arrowVector(${String(direction)}) → ${JSON.stringify(vector)}`,
        );
      }
      probe.check(
        typeof speedLabel(pick(rng, [1, 0.5, 0.25])) === 'string',
        'speedLabel not a string',
      );
    },
  },
  {
    id: 'drills.catalog.hostile',
    target: 'recommendedDrillsModel',
    dependency: 'training:catalog',
    mode: 'malformed',
    run(rng, probe) {
      const focus = drillFocusFromAnalysis(cloneAnalysis());
      probe.check(focus !== null, 'baseline focus missing');
      if (!focus) return;
      const limit = pick(rng, [0, -1, 1, 2, 3, 50]);
      const catalog = shuffled(rng, [
        ...DRILLS,
        ...DRILLS.map(d => ({ ...d, slug: `${d.slug}-copy` })),
      ]).slice(0, int(rng, 0, 12));
      const picks = neverThrows(probe, 'pickRecommendedDrills', () =>
        pickRecommendedDrills(catalog, focus, limit),
      );
      if (picks) {
        probe.check(
          picks.length <= Math.max(0, limit),
          `returned ${picks.length} drills for limit ${limit}`,
        );
        probe.check(
          picks.every(d => catalog.includes(d)),
          'recommended a drill outside the catalog',
        );
        const primary = picks.filter(d => d.families.includes(focus.family));
        const fill = picks.filter(d => !d.families.includes(focus.family));
        probe.check(
          fill.every(d => d.families.includes('global')),
          'filled with a drill from a different family',
        );
        probe.check(
          picks
            .slice(0, primary.length)
            .every(d => d.families.includes(focus.family)),
          'family drills must lead the list',
        );
      }
      const empty = neverThrows(probe, 'pickRecommendedDrills([])', () =>
        pickRecommendedDrills([], focus, 3),
      );
      probe.check(empty !== null && empty.length === 0, 'invented drills');
    },
  },
  {
    id: 'drills.focus.score-rounding',
    target: 'recommendedDrillsModel',
    dependency: 'sqlite:analysis-record',
    mode: 'malformed',
    run(rng, probe) {
      const score = pick(rng, [0.4, 0.5, 49.5, 99.999, 1e-9, 100, 0]);
      const analysis = hostileAnalysis(rng, a => {
        const list = a['checkpoints'] as Record<string, unknown>[];
        const contact = list.find(cp => cp['key'] === 'contact_position')!;
        contact['score'] = score;
        contact['band'] = 'red';
      });
      const focus = neverThrows(probe, 'drillFocusFromAnalysis', () =>
        drillFocusFromAnalysis(analysis),
      );
      probe.check(
        focus !== null &&
          focus.checkpoint === 'contact_position' &&
          focus.averageScore === Math.round(score) &&
          focus.sampleCount === 1,
        `focus for score ${score}: ${JSON.stringify(focus)}`,
      );
    },
  },
];

const FAULTS: Fault[] = [...SIDECAR_FAULTS, ...REVIEW_FAULTS, ...MODEL_FAULTS];

// ─── Campaign ───────────────────────────────────────────────────────────────

interface Row {
  seed: number;
  fault: string;
  target: Target;
  dependency: string;
  mode: Mode;
  outcome: 'HELD' | 'BROKEN';
  violations: string[];
  notes: string[];
  ms: number;
}

const OUT_FILE = join(
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress'),
  'review-models-failure-injection.json',
);
const ONLY_SEED = process.env.STRESS_SEED
  ? Number(process.env.STRESS_SEED)
  : null;
const REQUESTED_ITER = process.env.STRESS_ITER
  ? Number(process.env.STRESS_ITER)
  : null;
const ITERATIONS =
  ONLY_SEED !== null
    ? 1
    : Math.max(FAULTS.length, REQUESTED_ITER ?? FAULTS.length * 3);

function faultFor(seed: number): Fault {
  return FAULTS[((seed % FAULTS.length) + FAULTS.length) % FAULTS.length]!;
}

const seeds: number[] =
  ONLY_SEED !== null
    ? [ONLY_SEED]
    : Array.from({ length: ITERATIONS }, (_v, index) => index);

const rows: Row[] = [];

async function resetDependencies(): Promise<void> {
  mockCapture.read = () =>
    Promise.reject(new Error('capture read not configured'));
  mockDomain.sha256 = input => domain.sha256Hex(input);
  mockDomain.parse = (json, producedBy) =>
    domain.parsePoseSequence(json, producedBy);
  mockDb.reset();
  const rn = sharedReactNative;
  // Drain the shared module's serialized queue so no run from a previous
  // seed can leak into this one (a no-op run: StoreKit absent).
  installNative(rn, 'missing');
  const drained = await Promise.race([
    sharedReview.reportScoredAnalysisForReview({ delayMs: 0 }).then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!drained) {
    throw new Error('shared review queue is wedged from a previous seed');
  }
  mockDb.reset();
  installNative(rn, () => Promise.resolve(true));
}

async function runSeed(seed: number): Promise<Row> {
  const fault = faultFor(seed);
  const rng = mulberry32(seed);
  const probe = new Probe();
  const started = Date.now();
  try {
    await resetDependencies();
    await fault.run(rng, probe);
  } catch (error) {
    probe.violations.push(`harness caught ${describeError(error)}`);
  } finally {
    jest.useRealTimers();
    jest.restoreAllMocks();
  }
  return {
    seed,
    fault: fault.id,
    target: fault.target,
    dependency: fault.dependency,
    mode: fault.mode,
    outcome: probe.violations.length === 0 ? 'HELD' : 'BROKEN',
    violations: probe.violations,
    notes: probe.notes,
    ms: Date.now() - started,
  };
}

describe('review models — failure injection (seeded)', () => {
  it('covers ≥60 distinct injected faults across every dependency', () => {
    const ids = new Set(FAULTS.map(fault => fault.id));
    expect(ids.size).toBe(FAULTS.length);
    expect(FAULTS.length).toBeGreaterThanOrEqual(60);
    const modes = new Set(FAULTS.map(fault => fault.mode));
    for (const mode of [
      'throw',
      'reject',
      'timeout',
      'malformed',
      'partial',
      'slow',
      'never-resolves',
    ] as const) {
      expect(modes.has(mode)).toBe(true);
    }
    const targets = new Set(FAULTS.map(fault => fault.target));
    expect([...targets].sort()).toEqual([
      'appStoreReview',
      'formReviewGeometry',
      'formReviewModel',
      'poseSidecar',
      'recommendedDrillsModel',
    ]);
  });

  afterAll(() => {
    if (rows.length === 0) return;
    const summary = {
      generatedAt: new Date().toISOString(),
      faults: FAULTS.length,
      iterations: rows.length,
      held: rows.filter(row => row.outcome === 'HELD').length,
      broken: rows.filter(row => row.outcome === 'BROKEN').length,
      brokenSeeds: rows
        .filter(row => row.outcome === 'BROKEN')
        .map(row => row.seed),
      byFault: Object.fromEntries(
        FAULTS.map(fault => [
          fault.id,
          {
            runs: rows.filter(row => row.fault === fault.id).length,
            broken: rows.filter(
              row => row.fault === fault.id && row.outcome === 'BROKEN',
            ).length,
          },
        ]),
      ),
      replay:
        'cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/reviewModelsFailureInjection.test.ts',
      rows,
    };
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
  });

  it.each(seeds)('seed %i', async seed => {
    const row = await runSeed(seed);
    rows.push(row);
    expect({
      seed: row.seed,
      fault: row.fault,
      violations: row.violations,
    }).toEqual({ seed: row.seed, fault: row.fault, violations: [] });
  });
});
