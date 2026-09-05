/**
 * STRESS — mod-session-flow / failure-injection lens, part 2:
 * the native plumbing (src/flow/sessionNative.ts) driving a real
 * LiveSessionFlow against a SIMULATED bridge with injected faults:
 *
 *   - camera bridge `extractSessionEventClip`  → reject (Error / string) /
 *       sync throw / never / slow / null / undefined / number / a payload
 *       missing one required field / wrong captureMode / no pose sidecar
 *   - SQLite seam `savePendingCapture`          → reject / throw / never / slow
 *   - Vision/API seam `runCaptureAnalysis`      → reject / throw / never /
 *       slow / unavailable / paywall / quality_blocked / malformed outcomes
 *   - native motion stream                      → malformed payloads, foreign
 *       captureId, emissions after end()/disconnect()
 *   - NativeEventEmitter                        → addListener / remove throw
 *   - clock                                     → Date#toISOString throws
 *
 * Same harness contract as sessionFlowFailureInjection.stress.test.ts:
 * STRESS_ITER / STRESS_SEED, seed → outcome table under
 * artifacts/stress/mod-session-flow/, KNOWN findings recorded (not failed)
 * and pinned with test.failing repros; anything else is BROKEN.
 */
jest.mock('react-native', () => {
  const listeners: Array<(event: object) => void> = [];
  const emitterFaults = { addListenerThrows: false, removeThrows: false };
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
      addListener(_type: string, listener: (event: object) => void) {
        if (emitterFaults.addListenerThrows) {
          throw new Error('stress: NativeEventEmitter.addListener failed');
        }
        listeners.push(listener);
        return {
          remove: () => {
            if (emitterFaults.removeThrows) {
              throw new Error('stress: subscription.remove failed');
            }
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedBridge: bridge,
    __simulatedListeners: listeners,
    __emitterFaults: emitterFaults,
  };
});

jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import type { SessionStrokeEvent } from '@pickle/analysis-pipeline';
import type { LocalDb } from '../../src/data/db';
import type { CapturedClip } from '../../src/camera/capture';
import {
  LiveSessionFlow,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventClipSource,
  type SessionMotionSample,
} from '../../src/flow/session';
import {
  connectNativeSessionMotionFeed,
  createNativeSessionAnalysisProvider,
  createNativeSessionEventClipSource,
} from '../../src/flow/sessionNative';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { savePendingCapture } from '../../src/data/repository';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';

const {
  __simulatedBridge: mockBridge,
  __simulatedListeners: mockListeners,
  __emitterFaults: emitterFaults,
} = jest.requireMock('react-native') as {
  __simulatedBridge: { extractSessionEventClip: jest.Mock };
  __simulatedListeners: Array<(event: object) => void>;
  __emitterFaults: { addListenerThrows: boolean; removeThrows: boolean };
};
const mockRunCaptureAnalysis = runCaptureAnalysis as jest.Mock;
const mockSavePendingCapture = savePendingCapture as jest.Mock;

const samples: SessionMotionSample[] = fixture.wristSamples;
const CAPTURE_ID = 'stress-session-capture';

// ─── Seeded harness ─────────────────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends string>(
  rng: () => number,
  weights: Record<T, number>,
): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1]![0];
}

const DEFAULT_ITERATIONS = 32;

function campaignSeeds(base: number): number[] {
  const one = process.env.STRESS_SEED;
  if (one !== undefined && one !== '') return [Number(one)];
  const raw = process.env.STRESS_ITER;
  const iterations =
    raw !== undefined && raw !== '' ? Number(raw) : DEFAULT_ITERATIONS;
  return Array.from({ length: iterations }, (_, i) => base + i);
}

const ARTIFACT_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/stress/mod-session-flow',
);

function writeCampaignTable(name: string, table: object): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(table, null, 2));
  return file;
}

async function flushMicrotasks(rounds = 64): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

async function advanceFakeTime(totalMs: number, stepMs = 1_000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await flushMicrotasks(8);
  }
  await flushMicrotasks();
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

// ─── Known findings ─────────────────────────────────────────────────────────

const KNOWN_FINDINGS = {
  /** session.ts:522-577 — no deadline on a dispatch: a bridge extraction,
   * SQLite save or analysis that never settles leaves the event
   * 'processing' after 60 s of fake time. */
  F1_STUCK_PROCESSING_NO_DEADLINE: 'F1_STUCK_PROCESSING_NO_DEADLINE',
  /** sessionNative.ts:100-104 — the post-end auto-disconnect calls
   * `unsubscribe()` unguarded inside the emitter listener: a throwing
   * subscription.remove() escapes into the native event dispatch. */
  N1_AUTO_DISCONNECT_THROW_ESCAPES: 'N1_AUTO_DISCONNECT_THROW_ESCAPES',
} as const;
const KNOWN_FINDING_SET = new Set<string>(Object.values(KNOWN_FINDINGS));

// ─── Fault menus ────────────────────────────────────────────────────────────

type BridgeFault =
  | 'ok'
  | 'reject_error'
  | 'reject_string'
  | 'throw_sync'
  | 'never'
  | 'slow'
  | 'resolve_null'
  | 'resolve_undefined'
  | 'resolve_number'
  | 'missing_field'
  | 'wrong_capture_mode'
  | 'no_pose_sequence'
  | 'pose_sequence_null';

type SaveFault = 'ok' | 'reject' | 'throw_sync' | 'never' | 'slow';

type AnalysisFault =
  | 'scored'
  | 'low_confidence'
  | 'unavailable'
  | 'unavailable_paywall'
  | 'quality_blocked'
  | 'reject_error'
  | 'reject_string'
  | 'throw_sync'
  | 'never'
  | 'slow_scored'
  | 'malformed_no_record'
  | 'malformed_undefined'
  | 'unknown_kind';

type EmitterFault = 'ok' | 'add_listener_throws' | 'remove_throws';
type ClockFault = 'ok' | 'to_iso_throws';
type Lifecycle =
  'end_at_finish' | 'end_then_emit' | 'disconnect_mid' | 'disconnect_then_emit';

const BRIDGE_WEIGHTS: Record<BridgeFault, number> = {
  ok: 34,
  reject_error: 8,
  reject_string: 4,
  throw_sync: 5,
  never: 6,
  slow: 8,
  resolve_null: 5,
  resolve_undefined: 4,
  resolve_number: 3,
  missing_field: 10,
  wrong_capture_mode: 5,
  no_pose_sequence: 5,
  pose_sequence_null: 3,
};

const SAVE_WEIGHTS: Record<SaveFault, number> = {
  ok: 60,
  reject: 12,
  throw_sync: 8,
  never: 8,
  slow: 12,
};

const ANALYSIS_WEIGHTS: Record<AnalysisFault, number> = {
  scored: 26,
  low_confidence: 6,
  unavailable: 8,
  unavailable_paywall: 4,
  quality_blocked: 6,
  reject_error: 8,
  reject_string: 4,
  throw_sync: 5,
  never: 6,
  slow_scored: 8,
  malformed_no_record: 5,
  malformed_undefined: 4,
  unknown_kind: 5,
};

const EMITTER_WEIGHTS: Record<EmitterFault, number> = {
  ok: 84,
  add_listener_throws: 8,
  remove_throws: 8,
};

const CLOCK_WEIGHTS: Record<ClockFault, number> = { ok: 90, to_iso_throws: 10 };

const LIFECYCLE_WEIGHTS: Record<Lifecycle, number> = {
  end_at_finish: 40,
  end_then_emit: 25,
  disconnect_mid: 20,
  disconnect_then_emit: 15,
};

const REQUIRED_CLIP_FIELDS = [
  'uri',
  'durationMs',
  'fps',
  'width',
  'height',
  'capturedAtIso',
  'captureMode',
  'recognition',
  'trigger',
  'captureEvidence',
  'ballSpeed',
  'preRollMs',
  'postRollMs',
] as const;

/** Malformed `session_motion_sample` payloads the boundary must drop AND
 * count (they carry the frozen type). */
const COUNTED_JUNK: Array<[string, (sample: SessionMotionSample) => unknown]> =
  [
    [
      'tMs_nan',
      s => ({ type: 'session_motion_sample', tMs: Number.NaN, v: s.v }),
    ],
    ['tMs_negative', s => ({ type: 'session_motion_sample', tMs: -1, v: s.v })],
    [
      'tMs_infinity',
      s => ({ type: 'session_motion_sample', tMs: Infinity, v: s.v }),
    ],
    [
      'tMs_string',
      s => ({ type: 'session_motion_sample', tMs: String(s.tMs), v: s.v }),
    ],
    ['tMs_missing', s => ({ type: 'session_motion_sample', v: s.v })],
    [
      'v_nan',
      s => ({ type: 'session_motion_sample', tMs: s.tMs, v: Number.NaN }),
    ],
    [
      'v_negative',
      s => ({ type: 'session_motion_sample', tMs: s.tMs, v: -0.5 }),
    ],
    ['v_null', s => ({ type: 'session_motion_sample', tMs: s.tMs, v: null })],
    ['v_missing', s => ({ type: 'session_motion_sample', tMs: s.tMs })],
    [
      'captureId_number',
      s => ({
        type: 'session_motion_sample',
        tMs: s.tMs,
        v: s.v,
        captureId: 42,
      }),
    ],
    [
      'emittedAtIso_number',
      s => ({
        type: 'session_motion_sample',
        tMs: s.tMs,
        v: s.v,
        emittedAtIso: 7,
      }),
    ],
    [
      'tMs_object',
      s => ({ type: 'session_motion_sample', tMs: { ms: s.tMs }, v: s.v }),
    ],
  ];

/** Payloads that are not motion samples at all — silently ignored, NOT counted. */
const IGNORED_JUNK: Array<[string, unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['string', 'session_motion_sample'],
  ['number', 12],
  ['array', [1, 2, 3]],
  ['empty_object', {}],
  ['other_event', { type: 'capture_progress', fraction: 0.4 }],
  ['type_case', { type: 'Session_Motion_Sample', tMs: 10, v: 0.1 }],
];

interface EventPlan {
  bridge: BridgeFault;
  missingField: (typeof REQUIRED_CLIP_FIELDS)[number];
  save: SaveFault;
  analysis: AnalysisFault;
  slowMs: number;
  score: number;
  record: { id: string; result: unknown; strokeResolution: unknown } | null;
}

interface JunkEmission {
  index: number;
  kind: string;
  counted: boolean;
  payload: unknown;
}

interface IterationPlan {
  seed: number;
  emitter: EmitterFault;
  clock: ClockFault;
  lifecycle: Lifecycle;
  disconnectIndex: number;
  events: EventPlan[];
  junk: JunkEmission[];
  foreignIndices: number[];
  omitCaptureIdIndices: Set<number>;
}

function planIteration(seed: number): IterationPlan {
  const rng = makeRng(seed);
  const events: EventPlan[] = [];
  for (let i = 0; i < 8; i += 1) {
    const bridge = pickWeighted(rng, BRIDGE_WEIGHTS);
    const save = pickWeighted(rng, SAVE_WEIGHTS);
    const analysis = pickWeighted(rng, ANALYSIS_WEIGHTS);
    const score = Math.round(rng() * 100) / 10;
    const record =
      analysis === 'scored' || analysis === 'slow_scored'
        ? {
            id: `stress-analysis-${seed}-E${i + 1}`,
            strokeResolution: { kind: 'unresolved', reason: 'stress' },
            result: { resultKind: 'scored', overallScore: score },
          }
        : analysis === 'low_confidence'
          ? {
              id: `stress-analysis-${seed}-E${i + 1}`,
              strokeResolution: { kind: 'unresolved', reason: 'stress' },
              result: { resultKind: 'low_confidence', overallScore: null },
            }
          : null;
    events.push({
      bridge,
      missingField:
        REQUIRED_CLIP_FIELDS[Math.floor(rng() * REQUIRED_CLIP_FIELDS.length)]!,
      save,
      analysis,
      slowMs: 500 + Math.floor(rng() * 19_000),
      score,
      record,
    });
  }
  const junkCount = Math.floor(rng() * 5);
  const junk: JunkEmission[] = [];
  for (let j = 0; j < junkCount; j += 1) {
    const index = Math.floor(rng() * samples.length);
    const sample = samples[index]!;
    if (rng() < 0.7) {
      const [kind, make] =
        COUNTED_JUNK[Math.floor(rng() * COUNTED_JUNK.length)]!;
      junk.push({ index, kind, counted: true, payload: make(sample) });
    } else {
      const [kind, payload] =
        IGNORED_JUNK[Math.floor(rng() * IGNORED_JUNK.length)]!;
      junk.push({ index, kind, counted: false, payload });
    }
  }
  const foreignCount = Math.floor(rng() * 3);
  const foreignIndices: number[] = [];
  for (let j = 0; j < foreignCount; j += 1)
    foreignIndices.push(Math.floor(rng() * samples.length));
  const omitCaptureIdIndices = new Set<number>();
  const omitCount = Math.floor(rng() * 4);
  for (let j = 0; j < omitCount; j += 1)
    omitCaptureIdIndices.add(Math.floor(rng() * samples.length));
  return {
    seed,
    emitter: pickWeighted(rng, EMITTER_WEIGHTS),
    clock: pickWeighted(rng, CLOCK_WEIGHTS),
    lifecycle: pickWeighted(rng, LIFECYCLE_WEIGHTS),
    disconnectIndex: 20 + Math.floor(rng() * (samples.length - 30)),
    events,
    junk,
    foreignIndices,
    omitCaptureIdIndices,
  };
}

// ─── Bridge doubles ─────────────────────────────────────────────────────────

function validClipPayload(ordinal: number): Record<string, unknown> {
  return {
    uri: `file:///private/var/mobile/stress-E${ordinal + 1}.mov`,
    durationMs: 2100,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-08-28T10:00:05.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 767,
      endMs: 1567,
      peakMotionMs: 1100,
      confidence: 0.8,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 7,
      poseFrameCount: 6,
      poseMissingFrameCount: 1,
      trackedDurationMs: 620,
      meanCanonicalJointVisibility: 0.88,
      meanJointCoverage: 0.94,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 4,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 5,
          meanNormalizedPerSecond: 1.1,
          peakNormalizedPerSecond: 2.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///private/var/mobile/stress-E${ordinal + 1}.pose.json`,
      frameCount: 6,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

function ordinalFromClip(clip: CapturedClip): number {
  const match = /stress-E(\d+)\.mov$/.exec(clip.uri);
  if (!match) throw new Error(`stress: clip uri not stamped: ${clip.uri}`);
  return Number(match[1]) - 1;
}

function installBridgeFaults(plan: IterationPlan): void {
  let extractCalls = 0;
  mockBridge.extractSessionEventClip.mockImplementation(() => {
    const ordinal = extractCalls;
    extractCalls += 1;
    const ep = plan.events[Math.min(ordinal, plan.events.length - 1)]!;
    const payload = validClipPayload(ordinal);
    switch (ep.bridge) {
      case 'ok':
        return Promise.resolve(payload);
      case 'reject_error':
        return Promise.reject(
          new Error(`stress bridge reject E${ordinal + 1}`),
        );
      case 'reject_string':
        return Promise.reject(`stress bridge string E${ordinal + 1}`);
      case 'throw_sync':
        throw new Error(`stress bridge sync throw E${ordinal + 1}`);
      case 'never':
        return never();
      case 'slow':
        return after(ep.slowMs, payload);
      case 'resolve_null':
        return Promise.resolve(null);
      case 'resolve_undefined':
        return Promise.resolve(undefined);
      case 'resolve_number':
        return Promise.resolve(42);
      case 'missing_field':
        delete payload[ep.missingField];
        return Promise.resolve(payload);
      case 'wrong_capture_mode':
        payload.captureMode = 'imported_video';
        return Promise.resolve(payload);
      case 'no_pose_sequence':
        delete payload.poseSequence;
        return Promise.resolve(payload);
      case 'pose_sequence_null':
        payload.poseSequence = null;
        return Promise.resolve(payload);
    }
  });

  mockSavePendingCapture.mockImplementation(
    (
      _db: LocalDb,
      _captureId: string,
      _shotType: string,
      clip: CapturedClip,
    ) => {
      const ep =
        plan.events[Math.min(ordinalFromClip(clip), plan.events.length - 1)]!;
      switch (ep.save) {
        case 'ok':
          return Promise.resolve();
        case 'reject':
          return Promise.reject(new Error('stress sqlite: database is locked'));
        case 'throw_sync':
          throw new Error('stress sqlite: sync throw');
        case 'never':
          return never();
        case 'slow':
          return after(ep.slowMs, undefined);
      }
    },
  );

  mockRunCaptureAnalysis.mockImplementation((args: { clip: CapturedClip }) => {
    const ordinal = ordinalFromClip(args.clip);
    const ep = plan.events[Math.min(ordinal, plan.events.length - 1)]!;
    switch (ep.analysis) {
      case 'scored':
        return Promise.resolve({
          kind: 'scored',
          analysisId: ep.record!.id,
          record: ep.record,
          freeLimitReached: false,
        });
      case 'low_confidence':
        return Promise.resolve({
          kind: 'low_confidence',
          analysisId: ep.record!.id,
          record: ep.record,
          guidance: null,
        });
      case 'unavailable':
        return Promise.resolve({
          kind: 'unavailable',
          reason: `STRESS_UNAVAILABLE:E${ordinal + 1}`,
        });
      case 'unavailable_paywall':
        return Promise.resolve({
          kind: 'unavailable',
          reason: `STRESS_PAYWALL:E${ordinal + 1}`,
          cause: 'paywall_required',
        });
      case 'quality_blocked':
        return Promise.resolve({
          kind: 'quality_blocked',
          reason: `STRESS_QUALITY:E${ordinal + 1}`,
          envelope: null,
        });
      case 'reject_error':
        return Promise.reject(
          new Error(`stress analysis reject E${ordinal + 1}`),
        );
      case 'reject_string':
        return Promise.reject(`stress analysis string E${ordinal + 1}`);
      case 'throw_sync':
        throw new Error(`stress analysis sync throw E${ordinal + 1}`);
      case 'never':
        return never();
      case 'slow_scored':
        return after(ep.slowMs, {
          kind: 'scored',
          analysisId: ep.record!.id,
          record: ep.record,
          freeLimitReached: false,
        });
      case 'malformed_no_record':
        return Promise.resolve({ kind: 'scored', analysisId: 'x' });
      case 'malformed_undefined':
        return Promise.resolve(undefined);
      case 'unknown_kind':
        return Promise.resolve({ kind: 'analysis_failed', reason: 'stress' });
    }
  });
}

function emitNative(event: unknown): void {
  for (const listener of [...mockListeners]) listener(event as object);
}

function motionEvent(sample: SessionMotionSample, captureId?: string): object {
  return {
    type: 'session_motion_sample',
    tMs: sample.tMs,
    v: sample.v,
    ...(captureId === undefined ? {} : { captureId }),
    emittedAtIso: '2026-09-04T00:00:00.000Z',
  };
}

// ─── Invariants ─────────────────────────────────────────────────────────────

const LEGAL_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['pending', 'processing', 'abstained']),
  processing: new Set(['processing', 'pending', 'ready', 'abstained']),
  ready: new Set(['ready']),
  abstained: new Set(['abstained']),
};

const BRIDGE_REACHES_SAVE = new Set<BridgeFault>(['ok', 'slow']);
const SAVE_REACHES_ANALYSIS = new Set<SaveFault>(['ok', 'slow']);

interface EventOutcomeRow {
  bridge: BridgeFault;
  save: SaveFault;
  analysis: AnalysisFault;
  saveCalls: number;
  analysisCalls: number;
  finalState: string;
  reason: string | null;
}

interface SeedRow {
  seed: number;
  verdict: 'HELD' | 'HELD_KNOWN' | 'BROKEN';
  plan: {
    emitter: EmitterFault;
    clock: ClockFault;
    lifecycle: Lifecycle;
    junk: string[];
    foreignEmissions: number;
  };
  injectedFaults: number;
  connectThrew: boolean;
  disconnectThrew: boolean;
  droppedInvalidSamples: number | null;
  events: Record<string, EventOutcomeRow>;
  observations: string[];
  violations: string[];
  snapshotsSeen: number;
}

async function runIteration(seed: number): Promise<SeedRow> {
  const plan = planIteration(seed);
  const sessionId = `stress-native-${seed}`;
  const trail: LiveSessionSnapshot[] = [];
  const observations = new Set<string>();
  const violations: string[] = [];
  const extractionOrder: string[] = [];
  let injectedFaults = 0;

  mockListeners.length = 0;
  emitterFaults.addListenerThrows = plan.emitter === 'add_listener_throws';
  emitterFaults.removeThrows = plan.emitter === 'remove_throws';
  if (plan.emitter !== 'ok') injectedFaults += 1;
  mockBridge.extractSessionEventClip.mockReset();
  mockSavePendingCapture.mockReset();
  mockRunCaptureAnalysis.mockReset();
  installBridgeFaults(plan);

  const clockSpy =
    plan.clock === 'to_iso_throws'
      ? jest.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
          throw new RangeError('stress: invalid time value');
        })
      : null;
  if (clockSpy) injectedFaults += 1;

  const inner = createNativeSessionEventClipSource(CAPTURE_ID);
  const clipSource: SessionEventClipSource = {
    sourceId: inner.sourceId,
    extract(event: SessionStrokeEvent) {
      extractionOrder.push(event.eventId);
      return inner.extract(event);
    },
  };
  const provider = createNativeSessionAnalysisProvider({
    db: {
      execute: async () => ({ rows: [] }),
      close() {},
    } as unknown as LocalDb,
    apiConfig: { baseUrl: 'https://api.stress.invalid', token: 'stress-token' },
    appVersion: '0.0.0-stress',
    handedness: 'right',
  });
  const flow = new LiveSessionFlow({
    sessionId,
    source: 'live',
    provider,
    clipSource,
    onUpdate: snapshot => {
      trail.push(snapshot);
    },
  });

  let connection: ReturnType<typeof connectNativeSessionMotionFeed> | null =
    null;
  let connectThrew = false;
  let disconnectThrew = false;
  try {
    connection = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: CAPTURE_ID,
    });
  } catch (error) {
    connectThrew = true;
    if (plan.emitter !== 'add_listener_throws') {
      violations.push(
        `connect threw without an emitter fault: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (plan.emitter === 'add_listener_throws' && !connectThrew) {
    violations.push('addListener fault was swallowed silently');
  }

  // ── Stream the rally with junk / foreign / captureId-less emissions ─────
  let expectedDropped = 0;
  let expectedAccepted = 0;
  const emit = (payload: unknown): void => {
    try {
      emitNative(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (plan.emitter === 'remove_throws' && flow.ended()) {
        observations.add(KNOWN_FINDINGS.N1_AUTO_DISCONNECT_THROW_ESCAPES);
      } else {
        violations.push(`emission threw into the emitter: ${message}`);
      }
    }
  };
  if (connection) {
    for (let i = 0; i < samples.length; i += 1) {
      if (plan.lifecycle === 'disconnect_mid' && i === plan.disconnectIndex) {
        try {
          connection.disconnect();
        } catch {
          disconnectThrew = true;
        }
      }
      const disconnected =
        plan.lifecycle === 'disconnect_mid' && i >= plan.disconnectIndex;
      for (const junk of plan.junk) {
        if (junk.index !== i) continue;
        injectedFaults += 1;
        emit(junk.payload);
        if (junk.counted && !disconnected) expectedDropped += 1;
      }
      for (const foreign of plan.foreignIndices) {
        if (foreign !== i) continue;
        injectedFaults += 1;
        emit(motionEvent(samples[i]!, 'someone-elses-capture'));
      }
      const captureId = plan.omitCaptureIdIndices.has(i)
        ? undefined
        : CAPTURE_ID;
      emit(motionEvent(samples[i]!, captureId));
      if (!disconnected) expectedAccepted += 1;
    }
  }

  const eventsBeforeEnd = flow.snapshot().events.length;
  const snapshotAtEnd = flow.end();
  if (snapshotAtEnd.phase !== 'ended')
    violations.push('end() did not end the flow');

  if (connection) {
    if (plan.lifecycle === 'end_then_emit') {
      const before = flow.snapshot();
      for (const sample of samples.slice(0, 3)) {
        injectedFaults += 1;
        emit(
          motionEvent({ tMs: sample.tMs + 100_000, v: sample.v }, CAPTURE_ID),
        );
      }
      if (flow.snapshot().durationMs !== before.durationMs)
        violations.push('post-end emission changed the session axis');
      if (plan.emitter !== 'remove_throws' && mockListeners.length !== 0)
        violations.push(
          'feed did not auto-disconnect after a post-end emission',
        );
    }
    if (plan.lifecycle === 'disconnect_then_emit') {
      try {
        connection.disconnect();
      } catch {
        disconnectThrew = true;
      }
      const before = flow.snapshot();
      emit(motionEvent({ tMs: 500_000, v: 0.9 }, CAPTURE_ID));
      if (flow.snapshot().durationMs !== before.durationMs)
        violations.push('post-disconnect emission reached the flow');
    }
    if (disconnectThrew && plan.emitter !== 'remove_throws')
      violations.push('disconnect threw without an emitter fault');
    if (connection.droppedInvalidSamples() !== expectedDropped) {
      violations.push(
        `droppedInvalidSamples ${connection.droppedInvalidSamples()} !== expected ${expectedDropped}`,
      );
    }
  }

  await flushMicrotasks();
  await advanceFakeTime(60_000);
  const final = flow.snapshot();

  // ── Trail invariants ────────────────────────────────────────────────────
  let prevResolved = 0;
  const seenPoints = new Map<string, number>();
  for (let i = 1; i < trail.length; i += 1) {
    const prev = trail[i - 1]!;
    const next = trail[i]!;
    if (next.strokeCount < prev.strokeCount)
      violations.push('strokeCount decreased');
    if (next.durationMs < prev.durationMs)
      violations.push('durationMs decreased');
    if (next.droppedLateSamples < prev.droppedLateSamples)
      violations.push('droppedLateSamples decreased');
    for (let k = 0; k < prev.events.length; k += 1) {
      const a = prev.events[k]!;
      const b = next.events[k];
      if (!b || b.eventId !== a.eventId) {
        violations.push(`event list not append-only at ${a.eventId}`);
        continue;
      }
      if (b.startMs !== a.startMs || b.endMs !== a.endMs)
        violations.push(`bounds rewritten for ${a.eventId}`);
      if (!LEGAL_TRANSITIONS[a.state]?.has(b.state))
        violations.push(
          `illegal transition ${a.eventId}: ${a.state} → ${b.state}`,
        );
      if (a.state === 'ready' && b.analysis !== a.analysis)
        violations.push(`ready record replaced for ${a.eventId}`);
    }
    const progression = sessionScoreProgression(next.events);
    const resolved = progression.scoredCount + progression.noReadCount;
    if (resolved < prevResolved)
      violations.push('progression resolved count decreased');
    prevResolved = resolved;
    for (const point of progression.points) {
      const seen = seenPoints.get(point.eventId);
      if (seen !== undefined && seen !== point.score)
        violations.push(`plotted score changed for ${point.eventId}`);
      seenPoints.set(point.eventId, point.score);
    }
  }

  // ── Per-event ground truth ──────────────────────────────────────────────
  if (
    final.durationMs !==
    (expectedAccepted > 0
      ? Math.max(...samples.slice(0, expectedAccepted).map(s => s.tMs))
      : 0)
  ) {
    violations.push(
      `durationMs ${final.durationMs} does not match accepted samples`,
    );
  }
  if (connectThrew && final.events.length !== 0)
    violations.push('events appeared without a connected feed');
  if (
    final.events.length !== eventsBeforeEnd &&
    snapshotAtEnd.events.length !== final.events.length
  )
    violations.push('events appeared after end()');
  if (final.onUpdateFailures !== 0)
    violations.push('onUpdateFailures without a throwing subscriber');

  const saveCallsByOrdinal = new Map<number, number>();
  const captureIds = new Set<string>();
  for (const call of mockSavePendingCapture.mock.calls) {
    const ordinal = ordinalFromClip(call[3] as CapturedClip);
    saveCallsByOrdinal.set(ordinal, (saveCallsByOrdinal.get(ordinal) ?? 0) + 1);
    captureIds.add(call[1] as string);
    if (call[4] !== null)
      violations.push('savePendingCapture received a non-null declaration');
  }
  if (captureIds.size !== mockSavePendingCapture.mock.calls.length)
    violations.push('duplicate captureId persisted');
  const analysisCallsByOrdinal = new Map<number, number>();
  for (const call of mockRunCaptureAnalysis.mock.calls) {
    const args = call[0] as {
      clip: CapturedClip;
      declaredStroke: unknown;
      sessionId: unknown;
    };
    const ordinal = ordinalFromClip(args.clip);
    analysisCallsByOrdinal.set(
      ordinal,
      (analysisCallsByOrdinal.get(ordinal) ?? 0) + 1,
    );
    if (args.declaredStroke !== null)
      violations.push('analysis received an invented declaration');
    if (args.sessionId !== sessionId)
      violations.push('analysis received the wrong sessionId');
  }

  const events: Record<string, EventOutcomeRow> = {};
  final.events.forEach((view, ordinal) => {
    const ep = plan.events[Math.min(ordinal, plan.events.length - 1)]!;
    if (extractionOrder[ordinal] !== view.eventId) {
      violations.push(`extraction order mismatch at ${view.eventId}`);
    }
    const saveCalls = saveCallsByOrdinal.get(ordinal) ?? 0;
    const analysisCalls = analysisCallsByOrdinal.get(ordinal) ?? 0;
    events[view.eventId] = {
      bridge: ep.bridge,
      save: ep.save,
      analysis: ep.analysis,
      saveCalls,
      analysisCalls,
      finalState: view.state,
      reason: view.pendingReason ?? view.abstainReason,
    };
    if (ep.bridge !== 'ok') injectedFaults += 1;
    if (saveCalls > 0 && ep.save !== 'ok') injectedFaults += 1;
    if (
      analysisCalls > 0 &&
      ep.analysis !== 'scored' &&
      ep.analysis !== 'low_confidence'
    )
      injectedFaults += 1;
    const id = view.eventId;
    const dispatchFailed =
      view.state === 'abstained' &&
      (view.abstainReason ?? '').startsWith('ANALYSIS_DISPATCH_FAILED:');

    if (view.state === 'ready') {
      const readyInjected =
        analysisCalls === 1 &&
        (ep.analysis === 'scored' ||
          ep.analysis === 'low_confidence' ||
          ep.analysis === 'slow_scored');
      if (!readyInjected) violations.push(`${id}: FAKE SUCCESS`);
      else if (view.analysis !== ep.record)
        violations.push(`${id}: record substituted`);
      return;
    }
    if (!BRIDGE_REACHES_SAVE.has(ep.bridge)) {
      if (saveCalls !== 0)
        violations.push(`${id}: capture persisted despite a bridge fault`);
      if (analysisCalls !== 0)
        violations.push(`${id}: analysis ran despite a bridge fault`);
      if (ep.bridge === 'never') {
        if (view.state === 'processing')
          observations.add(KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE);
        else violations.push(`${id}: never-resolving bridge → ${view.state}`);
        return;
      }
      if (
        view.state !== 'pending' ||
        !(view.pendingReason ?? '').startsWith('SESSION_CLIP_')
      ) {
        violations.push(
          `${id}: bridge fault ${ep.bridge} → ${view.state}/${view.pendingReason}`,
        );
      }
      return;
    }
    if (saveCalls !== 1) {
      violations.push(
        `${id}: expected exactly one persisted capture, saw ${saveCalls}`,
      );
      return;
    }
    if (!SAVE_REACHES_ANALYSIS.has(ep.save)) {
      if (analysisCalls !== 0)
        violations.push(`${id}: analysis ran although the save failed`);
      if (ep.save === 'never') {
        if (view.state === 'processing')
          observations.add(KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE);
        else violations.push(`${id}: never-resolving save → ${view.state}`);
      } else if (!dispatchFailed) {
        violations.push(
          `${id}: save fault ${ep.save} → ${view.state}/${view.abstainReason}`,
        );
      }
      return;
    }
    if (analysisCalls !== 1) {
      violations.push(
        `${id}: expected exactly one analysis run, saw ${analysisCalls}`,
      );
      return;
    }
    switch (ep.analysis) {
      case 'scored':
      case 'low_confidence':
      case 'slow_scored':
        violations.push(`${id}: ready outcome lost (${view.state})`);
        return;
      case 'unavailable':
      case 'unavailable_paywall':
      case 'quality_blocked':
        if (
          view.state !== 'pending' ||
          !(view.pendingReason ?? '').startsWith('STRESS_')
        )
          violations.push(
            `${id}: honest pending lost (${view.state}/${view.pendingReason})`,
          );
        return;
      case 'reject_error':
      case 'reject_string':
      case 'throw_sync':
      case 'malformed_no_record':
      case 'malformed_undefined':
      case 'unknown_kind':
        if (!dispatchFailed)
          violations.push(
            `${id}: analysis fault ${ep.analysis} → ${view.state}/${view.abstainReason}`,
          );
        return;
      case 'never':
        if (view.state === 'processing')
          observations.add(KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE);
        else violations.push(`${id}: never-resolving analysis → ${view.state}`);
        return;
    }
  });

  // Registry (LiveSummary's source) mirrors the live snapshot.
  const registered = getCompletedSession(sessionId);
  if (JSON.stringify(registered) !== JSON.stringify(final))
    violations.push('completed-session registry diverged from snapshot');

  const progression = sessionScoreProgression(final.events);
  if (
    progression.scoredCount +
      progression.noReadCount +
      progression.pendingCount !==
    final.events.length
  )
    violations.push('progression buckets do not cover every event');

  for (const code of observations)
    if (!KNOWN_FINDING_SET.has(code))
      violations.push(`unknown observation ${code}`);

  clockSpy?.mockRestore();
  emitterFaults.addListenerThrows = false;
  emitterFaults.removeThrows = false;

  return {
    seed,
    verdict:
      violations.length > 0
        ? 'BROKEN'
        : observations.size > 0
          ? 'HELD_KNOWN'
          : 'HELD',
    plan: {
      emitter: plan.emitter,
      clock: plan.clock,
      lifecycle: plan.lifecycle,
      junk: plan.junk.map(j => j.kind),
      foreignEmissions: plan.foreignIndices.length,
    },
    injectedFaults,
    connectThrew,
    disconnectThrew,
    droppedInvalidSamples: connection
      ? connection.droppedInvalidSamples()
      : null,
    events,
    observations: [...observations].sort(),
    violations,
    snapshotsSeen: trail.length,
  };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

describe('stress/failure-injection: native session plumbing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('survives the seeded bridge/SQLite/analysis fault campaign', async () => {
    const seeds = campaignSeeds(5_000);
    const rows: SeedRow[] = [];
    for (const seed of seeds) rows.push(await runIteration(seed));

    const totalFaults = rows.reduce((sum, row) => sum + row.injectedFaults, 0);
    const broken = rows.filter(row => row.verdict === 'BROKEN');
    const observationCounts: Record<string, number> = {};
    for (const row of rows)
      for (const code of row.observations)
        observationCounts[code] = (observationCounts[code] ?? 0) + 1;

    const file = writeCampaignTable('sessionNative.failureInjection', {
      campaign: 'sessionNative.failureInjection',
      unit: 'apps/mobile/src/flow/sessionNative.ts (+ session.ts, sessionProgress.ts)',
      iterations: rows.length,
      injectedFaults: totalFaults,
      verdicts: {
        HELD: rows.filter(r => r.verdict === 'HELD').length,
        HELD_KNOWN: rows.filter(r => r.verdict === 'HELD_KNOWN').length,
        BROKEN: broken.length,
      },
      observationCounts,
      knownFindings: KNOWN_FINDINGS,
      rows,
    });

    expect(rows.length).toBe(seeds.length);
    if (seeds.length >= DEFAULT_ITERATIONS)
      expect(totalFaults).toBeGreaterThanOrEqual(60);
    expect({
      brokenSeeds: broken.map(row => ({
        seed: row.seed,
        violations: row.violations,
      })),
      table: file,
    }).toEqual({ brokenSeeds: [], table: file });
  });

  it('is replayable: the same seed produces the same outcome row', async () => {
    const seed = Number(process.env.STRESS_SEED ?? 5_011);
    const a = await runIteration(seed);
    const b = await runIteration(seed);
    expect(b).toEqual(a);
  });
});

// ─── Known findings — deterministic repros (test.failing: red once fixed) ──

describe('stress/failure-injection: native known findings (expected invariants)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockListeners.length = 0;
    emitterFaults.addListenerThrows = false;
    emitterFaults.removeThrows = false;
    mockBridge.extractSessionEventClip.mockReset();
    mockSavePendingCapture.mockReset();
    mockRunCaptureAnalysis.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    emitterFaults.removeThrows = false;
  });

  function liveFlow(sessionId: string): LiveSessionFlow {
    return new LiveSessionFlow({
      sessionId,
      source: 'live',
      provider: createNativeSessionAnalysisProvider({
        db: {
          execute: async () => ({ rows: [] }),
          close() {},
        } as unknown as LocalDb,
        apiConfig: { baseUrl: 'https://api.stress.invalid', token: 't' },
        appVersion: '0.0.0-stress',
        handedness: 'right',
      }),
      clipSource: createNativeSessionEventClipSource(CAPTURE_ID),
    });
  }

  test.failing(
    `${KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE}: a bridge extraction that never returns must not leave events 'processing' after 60s`,
    async () => {
      mockBridge.extractSessionEventClip.mockImplementation(() => never());
      const flow = liveFlow('stress-native-f1');
      connectNativeSessionMotionFeed(flow, { sessionCaptureId: CAPTURE_ID });
      for (const sample of samples) emitNative(motionEvent(sample, CAPTURE_ID));
      flow.end();
      await advanceFakeTime(60_000);
      const states = flow.snapshot().events.map(e => e.state);
      expect(states.length).toBeGreaterThan(0);
      expect(states).not.toContain('processing');
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE}: a SQLite save that never settles must not leave events 'processing' after 60s`,
    async () => {
      mockBridge.extractSessionEventClip.mockImplementation(() =>
        Promise.resolve(validClipPayload(0)),
      );
      mockSavePendingCapture.mockImplementation(() => never());
      const flow = liveFlow('stress-native-f1b');
      connectNativeSessionMotionFeed(flow, { sessionCaptureId: CAPTURE_ID });
      for (const sample of samples) emitNative(motionEvent(sample, CAPTURE_ID));
      flow.end();
      await advanceFakeTime(60_000);
      expect(mockRunCaptureAnalysis).not.toHaveBeenCalled();
      expect(flow.snapshot().events.map(e => e.state)).not.toContain(
        'processing',
      );
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.N1_AUTO_DISCONNECT_THROW_ESCAPES}: a throwing subscription.remove() must not escape the post-end listener`,
    () => {
      mockBridge.extractSessionEventClip.mockImplementation(() => never());
      const flow = liveFlow('stress-native-n1');
      connectNativeSessionMotionFeed(flow, { sessionCaptureId: CAPTURE_ID });
      for (const sample of samples) emitNative(motionEvent(sample, CAPTURE_ID));
      flow.end();
      emitterFaults.removeThrows = true;
      expect(() =>
        emitNative(motionEvent({ tMs: 99_999, v: 0.2 }, CAPTURE_ID)),
      ).not.toThrow();
    },
  );
});
