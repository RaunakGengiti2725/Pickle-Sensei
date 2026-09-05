/**
 * STRESS / failure-injection — `mod-capture` (capture.ts, captureEnvelope.ts,
 * deviceBench.ts).
 *
 * Every iteration is derived from a 32-bit seed (mulberry32) and is replayable
 * with `STRESS_SEED=<seed> STRESS_ITER=1`. The default campaign sizes are small
 * enough to live in the normal suite; `STRESS_ITER=<n>` scales every campaign,
 * and `STRESS_OUT=<dir>` writes the seed → outcome table as JSON.
 *
 * Injected dependency faults (the unit's only runtime dependency is the
 * native `PickleVideoCapture` bridge + its event emitter):
 *   - method missing (build without the feature)         → honest unavailable
 *   - synchronous throw / rejected promise (Error, code) → rejection passes through
 *   - rejection with a non-Error value                    → still a rejection
 *   - never resolves (60s of fake time)                   → still pending, cancel reachable
 *   - slow (5–59s) then valid / malformed payload         → validated result / rejection
 *   - malformed scalar receipts                           → rejection
 *   - partial payloads (required field removed)          → rejection
 *   - poisoned field values (NaN, ±Infinity, -1, '', …)   → rejection unless benign
 *   - malformed native events (readiness / quality)       → envelope stays honest
 *   - device-bench samples with frame drops, odd fps, non-monotonic / NaN
 *     timestamps, missing unavailable reasons             → export invalid, never fabricated
 *
 * Invariants asserted on every iteration: no fake success (an invalid payload
 * never becomes a CapturedClip / receipt / export), no silent failure (every
 * fault surfaces as a rejection or a validation error), no infinite wait is
 * mistaken for success, and no evidence is invented for a signal nobody read.
 *
 * Known finding this harness reproduces (the oracle is deliberately NOT
 * relaxed; the campaign stays red until the boundary is fixed):
 *   - live-envelope-malformed-events: `subscribeToCameraEvents` forwards the
 *     native payload with an unchecked cast and `classifyDimension` only
 *     treats null/NaN as unmeasured, so undefined / string / boolean /
 *     ±Infinity fields are classified SUPPORTED or UNSUPPORTED instead of
 *     NOT_MEASURED (replay STRESS_SEED=4146388562 / 3605883793 / 3341672355
 *     / 2369009930 with STRESS_ITER=1).
 */
jest.mock('react-native', () => {
  const listeners: Array<(event: object) => void> = [];
  const bridge: Record<string, unknown> = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    readTextFile: jest.fn(),
    setCompletionStrategy: jest.fn(),
    startSessionCapture: jest.fn(),
    stopSessionCapture: jest.fn(),
    extractSessionEventClip: jest.fn(),
    extractImportedPoseSequence: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener(_type: string, listener: (event: object) => void) {
        listeners.push(listener);
        return {
          remove: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedBridge: bridge,
    __simulatedListeners: listeners,
  };
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvelopeVerdict } from '@pickle/shared-types';
import { ENVELOPE_DIMENSIONS } from '@pickle/shared-types';
import {
  assertCapturedClip,
  captureStrokeVideo,
  cancelCameraOperation,
  extractImportedPoseSequence,
  extractSessionEventClip,
  importedPoseExtractionAvailable,
  importStrokeVideo,
  readCaptureArtifact,
  sessionCaptureAvailable,
  setCaptureCompletionStrategy,
  startSessionCapture,
  stopSessionCapture,
  subscribeToCameraEvents,
  videoImportAvailable,
  cameraAvailable,
  type CameraEvent,
  type CapturedClip,
  type CaptureQualitySignalsV1,
} from '../../src/camera/capture';
import {
  attemptCaptureEnvelope,
  captureGuidanceLines,
  createAttemptEvidenceBuffer,
  liveCaptureEnvelope,
  qualityBlockedMessage,
  readyGate,
  sessionEventClipEnvelope,
} from '../../src/camera/captureEnvelope';
import {
  DEVICE_BENCH_SCHEMA_VERSION,
  DeviceBenchRecorder,
  deviceBenchExportFilename,
  validateDeviceBenchExport,
  type DeviceBenchExportV1,
} from '../../src/camera/deviceBench';

const { __simulatedBridge: bridge, __simulatedListeners: listeners } =
  jest.requireMock('react-native') as {
    __simulatedBridge: Record<string, jest.Mock | undefined>;
    __simulatedListeners: Array<(event: object) => void>;
  };

// ---------------------------------------------------------------------------
// Seeded RNG + campaign bookkeeping
// ---------------------------------------------------------------------------

const STRESS_ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '24') || 24);
const STRESS_SEED = Number(process.env.STRESS_SEED ?? '20260905') >>> 0;
const STRESS_OUT = process.env.STRESS_OUT;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(items.length)] as T;
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

/** Seed of iteration `i` of a campaign: replayable independently of others. */
function iterationSeed(campaign: number, i: number): number {
  const rng = mulberry32((STRESS_SEED ^ (campaign * 0x9e3779b9)) >>> 0);
  let seed = 0;
  for (let k = 0; k <= i; k += 1) seed = Math.floor(rng() * 4294967296);
  return seed >>> 0;
}

interface Row {
  campaign: string;
  iteration: number;
  seed: number;
  scenario: string;
  outcome: 'HELD' | 'BROKEN';
  detail: string;
}

const results: Row[] = [];

/** `STRESS_SEED=<seed> STRESS_ITER=1` replays exactly one iteration per campaign. */
const REPLAY_SINGLE_SEED =
  Boolean(process.env.STRESS_SEED) && process.env.STRESS_ITER === '1';

/** Runs one seeded iteration; assertion failures become BROKEN rows instead
 * of aborting the campaign so every failing seed is reported at once. */
async function runCampaign(
  name: string,
  campaignIndex: number,
  body: (rng: Rng, seed: number) => Promise<string> | string,
): Promise<Row[]> {
  const rows: Row[] = [];
  const count = REPLAY_SINGLE_SEED ? 1 : STRESS_ITER;
  for (let i = 0; i < count; i += 1) {
    const seed = REPLAY_SINGLE_SEED
      ? STRESS_SEED
      : iterationSeed(campaignIndex, i);
    const rng = new Rng(seed);
    let scenario = '';
    const label = (s: string) => {
      scenario = s;
    };
    try {
      const detail = await body(
        Object.assign(rng, { label }) as Rng & { label: typeof label },
        seed,
      );
      rows.push({
        campaign: name,
        iteration: i,
        seed,
        scenario,
        outcome: 'HELD',
        detail,
      });
    } catch (error) {
      rows.push({
        campaign: name,
        iteration: i,
        seed,
        scenario,
        outcome: 'BROKEN',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  results.push(...rows);
  return rows;
}

function broken(rows: Row[]): Row[] {
  return rows.filter(row => row.outcome === 'BROKEN');
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

afterAll(() => {
  if (!STRESS_OUT) return;
  fs.mkdirSync(STRESS_OUT, { recursive: true });
  const file = path.join(STRESS_OUT, 'captureBridgeFaults.results.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        suite: 'captureBridgeFaults.stress',
        baseSeed: STRESS_SEED,
        iterationsPerCampaign: STRESS_ITER,
        executed: results.length,
        broken: results.filter(r => r.outcome === 'BROKEN').length,
        rows: results,
      },
      null,
      2,
    ),
  );
});

// ---------------------------------------------------------------------------
// Valid fixtures (the shapes the native bridge really returns)
// ---------------------------------------------------------------------------

const baseClip = {
  uri: 'file:///private/var/mobile/clip.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
};

const trigger = {
  startMs: 2000,
  endMs: 2700,
  peakMotionMs: 2400,
  confidence: 0.82,
  source: 'temporal_pose_motion',
  modelVersion: 'temporal-stroke-heuristic-2',
};

const captureEvidence = {
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
      joint: 'left_shoulder',
      sampleCount: 3,
      meanNormalizedPerSecond: 0.3,
      peakNormalizedPerSecond: 0.7,
    },
    {
      joint: 'left_wrist',
      sampleCount: 5,
      meanNormalizedPerSecond: 1.1,
      peakNormalizedPerSecond: 2.4,
    },
  ],
};

const automaticClip = {
  ...baseClip,
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
};

const importedClip = {
  ...baseClip,
  uri: 'file:///private/var/mobile/import.mov',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

const poseSequenceRef = {
  schemaVersion: 1,
  format: 'pickle.pose-sequence.v1',
  uri: 'file:///private/var/mobile/import.pose.json',
  frameCount: 126,
  sha256: 'a'.repeat(64),
  coordinateSystem: 'normalized_image_top_left',
  poseModelVersion: 'apple-vision-bodypose-1',
};

const importedPoseExtraction = {
  poseSequence: poseSequenceRef,
  posterUri: 'file:///private/var/mobile/import.poster.jpg',
  framesWithPose: 120,
  framesTotal: 126,
};

const sessionBounds = {
  startMs: 1000,
  endMs: 1700,
  peakMs: 1400,
  confidence: 0.7,
  detectionModelVersion: 'session-engine-1',
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Every leaf path of an object (dot separated; arrays indexed). */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix];
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${key}` : key;
    out.push(next);
    if (typeof child === 'object' && child !== null) {
      out.push(...leafPaths(child, next));
    }
  }
  return out;
}

function setPath(target: unknown, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cursor = target as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor[parts[i] as string] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  if (value === DELETE) delete cursor[last];
  else cursor[last] = value;
}

const DELETE = Symbol('delete');

const POISONS: ReadonlyArray<{ name: string; value: unknown }> = [
  { name: 'NaN', value: Number.NaN },
  { name: '+Infinity', value: Number.POSITIVE_INFINITY },
  { name: '-Infinity', value: Number.NEGATIVE_INFINITY },
  { name: '-1', value: -1 },
  { name: '0', value: 0 },
  { name: '1.5', value: 1.5 },
  { name: '1e15', value: 1e15 },
  { name: 'empty-string', value: '' },
  { name: 'garbage-string', value: 'garbage' },
  { name: 'http-uri', value: 'http://evil.example/clip.mov' },
  { name: 'null', value: null },
  { name: 'true', value: true },
  { name: 'object', value: {} },
  { name: 'array', value: [] },
  { name: 'deleted', value: DELETE },
];

/**
 * Field/poison pairs the contract ACCEPTS by design — a string field takes any
 * nonempty string, a bounded duration takes 0, an integer count takes a
 * consistent value. Everything else accepted is BROKEN.
 */
const ACCEPTED_BY_DESIGN: ReadonlySet<string> = new Set([
  // fps 0 is the contract's "frame rate unknown" sentinel (CaptureEvidenceCard
  // renders it as '—'); fractional and large finite rates are legal numbers
  'fps=0',
  'fps=1.5',
  'fps=1e15',
  // finite positive integers/magnitudes are not plausibility-capped
  'width=1e15',
  'height=1e15',
  'captureEvidence.jointMotion.0.peakNormalizedPerSecond=1e15',
  'captureEvidence.jointMotion.1.peakNormalizedPerSecond=1e15',
  // a unit-interval confidence admits 0
  'trigger.confidence=0',
  // free-form provenance strings: any nonempty string is a valid version/reason
  'recognition.reason=garbage-string',
  'recognition.reason=http-uri',
  'ballSpeed.reason=garbage-string',
  'ballSpeed.reason=http-uri',
  'trigger.modelVersion=garbage-string',
  'trigger.modelVersion=http-uri',
  'captureEvidence.poseModelVersion=garbage-string',
  'captureEvidence.poseModelVersion=http-uri',
  'captureEvidence.triggerAlgorithmVersion=garbage-string',
  'captureEvidence.triggerAlgorithmVersion=http-uri',
  'poseSequence.poseModelVersion=garbage-string',
  'poseSequence.poseModelVersion=http-uri',
  // bounded durations that legitimately admit 0 / a shorter roll
  'preRollMs=0',
  'preRollMs=1.5',
  'postRollMs=0',
  'postRollMs=1.5',
  'trigger.startMs=0',
  'trigger.startMs=1.5',
  'trigger.peakMotionMs=deleted',
  'captureEvidence.trackedDurationMs=0',
  'captureEvidence.trackedDurationMs=1.5',
  // measured motion magnitudes may legitimately be 0 / fractional
  'captureEvidence.jointMotion.0.meanNormalizedPerSecond=0',
  'captureEvidence.jointMotion.0.meanNormalizedPerSecond=1.5',
  'captureEvidence.jointMotion.0.peakNormalizedPerSecond=1.5',
  'captureEvidence.jointMotion.1.meanNormalizedPerSecond=0',
  'captureEvidence.jointMotion.1.meanNormalizedPerSecond=1.5',
  'captureEvidence.jointMotion.1.peakNormalizedPerSecond=1.5',
  'captureEvidence.jointMotion.0.sampleCount=1.5',
  'captureEvidence.jointMotion.1.sampleCount=1.5',
  'captureEvidence.fullBodyVisibleFrameCount=0',
  'captureEvidence.minimumJointCoverage=0',
  'captureEvidence.meanCanonicalJointVisibility=0',
  'captureEvidence.meanJointCoverage=0',
  // an optional poster/pose sidecar may be absent
  'posterUri=deleted',
  // a large but finite positive duration/size is a legal number
  'durationMs=1e15',
  'framesTotal=1e15',
  'poseSequence.frameCount=1e15',
]);

// ---------------------------------------------------------------------------
// Campaign 1 — native bridge method faults
// ---------------------------------------------------------------------------

type BridgeMethod =
  | 'capture'
  | 'importVideo'
  | 'startSessionCapture'
  | 'stopSessionCapture'
  | 'extractSessionEventClip'
  | 'extractImportedPoseSequence'
  | 'readTextFile'
  | 'setCompletionStrategy';

const BRIDGE_METHODS: readonly BridgeMethod[] = [
  'capture',
  'importVideo',
  'startSessionCapture',
  'stopSessionCapture',
  'extractSessionEventClip',
  'extractImportedPoseSequence',
  'readTextFile',
  'setCompletionStrategy',
];

type FaultKind =
  | 'unavailable'
  | 'throw_sync'
  | 'reject_error'
  | 'reject_non_error'
  | 'never_resolves'
  | 'slow_valid'
  | 'slow_malformed'
  | 'malformed_scalar'
  | 'partial'
  | 'poisoned';

const FAULT_KINDS: readonly FaultKind[] = [
  'unavailable',
  'throw_sync',
  'reject_error',
  'reject_non_error',
  'never_resolves',
  'slow_valid',
  'slow_malformed',
  'malformed_scalar',
  'partial',
  'poisoned',
];

const NATIVE_ERROR_CODES = [
  'camera.cancelled',
  'camera.permission_denied',
  'camera.import_too_long',
  'camera.import_no_person',
  'camera.session_interrupted',
  'camera.disk_full',
  'E_UNKNOWN',
] as const;

function callWrapper(method: BridgeMethod): Promise<unknown> {
  switch (method) {
    case 'capture':
      return captureStrokeVideo();
    case 'importVideo':
      return importStrokeVideo();
    case 'startSessionCapture':
      return startSessionCapture();
    case 'stopSessionCapture':
      return stopSessionCapture('session-1');
    case 'extractSessionEventClip':
      return extractSessionEventClip('session-1', sessionBounds);
    case 'extractImportedPoseSequence':
      return extractImportedPoseSequence(
        assertCapturedClip(importedClip, 'imported_video') as Extract<
          CapturedClip,
          { captureMode: 'imported_video' }
        >,
        { x: 0.5, y: 0.5 },
      );
    case 'readTextFile':
      return readCaptureArtifact('file:///private/var/mobile/pose.json');
    case 'setCompletionStrategy':
      return setCaptureCompletionStrategy('fixed');
  }
}

function validPayload(method: BridgeMethod, rng: Rng): unknown {
  switch (method) {
    case 'capture':
    case 'extractSessionEventClip':
      return clone(automaticClip);
    case 'importVideo':
      return clone(importedClip);
    case 'startSessionCapture':
      return { sessionCaptureId: `session-${rng.int(1e6)}` };
    case 'stopSessionCapture':
      return undefined;
    case 'extractImportedPoseSequence':
      return clone(importedPoseExtraction);
    case 'readTextFile':
      return JSON.stringify({ schemaVersion: 1, frames: [] });
    case 'setCompletionStrategy':
      return 'fixed';
  }
}

/** Methods whose receipt has a validated object contract. */
const OBJECT_CONTRACT: ReadonlySet<BridgeMethod> = new Set([
  'capture',
  'importVideo',
  'extractSessionEventClip',
  'extractImportedPoseSequence',
  'startSessionCapture',
]);

const MALFORMED_SCALARS: readonly unknown[] = [
  null,
  undefined,
  '',
  'ok',
  0,
  42,
  true,
  [],
  [automaticClip],
  () => automaticClip,
];

function availabilityFor(method: BridgeMethod): boolean | null {
  switch (method) {
    case 'capture':
      return cameraAvailable();
    case 'importVideo':
      return videoImportAvailable();
    case 'startSessionCapture':
    case 'stopSessionCapture':
    case 'extractSessionEventClip':
      return sessionCaptureAvailable();
    case 'extractImportedPoseSequence':
      return importedPoseExtractionAvailable();
    default:
      return null;
  }
}

/** Resolves 'pending' if `promise` has not settled by the time the
 * microtask queue drains; otherwise the settlement. */
async function settlementOf(
  promise: Promise<unknown>,
): Promise<
  | { state: 'pending' }
  | { state: 'resolved'; value: unknown }
  | { state: 'rejected'; reason: unknown }
> {
  let result:
    | { state: 'pending' }
    | { state: 'resolved'; value: unknown }
    | { state: 'rejected'; reason: unknown } = { state: 'pending' };
  promise.then(
    value => {
      result = { state: 'resolved', value };
    },
    reason => {
      result = { state: 'rejected', reason };
    },
  );
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  return result;
}

describe('stress/mod-capture — native bridge method faults', () => {
  const originalMethods: Record<string, jest.Mock | undefined> = {};

  beforeAll(() => {
    for (const method of BRIDGE_METHODS)
      originalMethods[method] = bridge[method];
  });

  function restoreBridge(): void {
    for (const method of BRIDGE_METHODS) {
      bridge[method] = originalMethods[method];
      bridge[method]?.mockReset();
    }
    bridge.cancel?.mockReset();
  }

  beforeEach(() => {
    jest.useFakeTimers();
    restoreBridge();
  });

  afterEach(() => {
    jest.useRealTimers();
    restoreBridge();
  });

  it('every injected bridge fault is rejected honestly (no fake success, no silent failure)', async () => {
    const rows = await runCampaign('bridge-method-faults', 1, async rng => {
      restoreBridge();
      const label = (rng as Rng & { label: (s: string) => void }).label;
      const method = rng.pick(BRIDGE_METHODS);
      let kind = rng.pick(FAULT_KINDS);
      // Only object-contract receipts have a payload to malform.
      if (
        (kind === 'partial' ||
          kind === 'poisoned' ||
          kind === 'malformed_scalar' ||
          kind === 'slow_malformed') &&
        !OBJECT_CONTRACT.has(method) &&
        method !== 'setCompletionStrategy'
      ) {
        kind = 'reject_error';
      }
      if (
        (kind === 'partial' || kind === 'poisoned') &&
        method === 'setCompletionStrategy'
      ) {
        kind = 'malformed_scalar';
      }
      if (kind === 'partial' && method === 'startSessionCapture') {
        kind = 'malformed_scalar';
      }
      const mock = bridge[method];
      if (mock === undefined) {
        throw new Error(`bridge method ${method} missing from fixture`);
      }

      switch (kind) {
        case 'unavailable': {
          label(`${method}: method missing from native module`);
          delete bridge[method];
          const availability = availabilityFor(method);
          if (availability !== null) {
            check(
              availability === false,
              `${method} reported available while missing`,
            );
          }
          let rejected: unknown = undefined;
          try {
            await callWrapper(method);
            throw new Error(`${method} resolved with the method missing`);
          } catch (error) {
            rejected = error;
          }
          check(
            rejected instanceof Error &&
              /not available/i.test(rejected.message),
            `${method}: missing-method rejection is not an honest "not available" Error: ${String(rejected)}`,
          );
          return 'rejected: not available';
        }

        case 'throw_sync':
        case 'reject_error': {
          const code = rng.pick(NATIVE_ERROR_CODES);
          const message = `native failure ${rng.int(1e9)}`;
          const error = Object.assign(new Error(message), { code });
          label(`${method}: ${kind} Error(code=${code})`);
          if (kind === 'throw_sync') {
            mock.mockImplementation(() => {
              throw error;
            });
          } else {
            mock.mockRejectedValue(error);
          }
          const settled = await settlementOf(callWrapper(method));
          check(
            settled.state === 'rejected',
            `${method}: ${kind} did not reject (state=${settled.state})`,
          );
          check(
            settled.state === 'rejected' && settled.reason === error,
            `${method}: rejection was replaced/wrapped — the native code ${code} must pass through untouched`,
          );
          return `rejected with original Error, code preserved (${code})`;
        }

        case 'reject_non_error': {
          const reason = rng.pick([
            'string reason',
            undefined,
            null,
            42,
            { code: 'camera.cancelled' },
          ] as const);
          label(`${method}: reject with non-Error ${JSON.stringify(reason)}`);
          mock.mockRejectedValue(reason);
          const settled = await settlementOf(callWrapper(method));
          check(
            settled.state === 'rejected',
            `${method}: non-Error rejection was swallowed (state=${settled.state})`,
          );
          return `rejected (reason passed through as ${typeof reason})`;
        }

        case 'never_resolves': {
          label(`${method}: never resolves (60s fake time)`);
          mock.mockImplementation(() => new Promise(() => {}));
          const pending = callWrapper(method);
          // Attach the handler before advancing so an unexpected settlement
          // is observed instead of becoming an unhandled rejection.
          const settledPromise = settlementOf(pending);
          jest.advanceTimersByTime(60_000);
          const settled = await settledPromise;
          check(
            settled.state === 'pending',
            `${method}: promise settled on its own after 60s (state=${settled.state}) — nothing should have produced a value`,
          );
          cancelCameraOperation();
          check(
            bridge.cancel?.mock.calls.length === 1,
            `${method}: cancelCameraOperation did not reach the native cancel`,
          );
          return 'still pending after 60s; native cancel reachable';
        }

        case 'slow_valid':
        case 'slow_malformed': {
          const delayMs = 5_000 + rng.int(54_000);
          const payload =
            kind === 'slow_valid'
              ? validPayload(method, rng)
              : rng.pick(MALFORMED_SCALARS);
          label(
            `${method}: resolves after ${delayMs}ms with ${kind === 'slow_valid' ? 'a valid' : 'a malformed'} receipt`,
          );
          mock.mockImplementation(
            () =>
              new Promise(resolve => {
                setTimeout(() => resolve(payload), delayMs);
              }),
          );
          const pending = callWrapper(method);
          const before = await settlementOf(pending);
          check(
            before.state === 'pending',
            `${method}: slow call settled before its delay`,
          );
          jest.advanceTimersByTime(delayMs);
          const after = await settlementOf(pending);
          if (kind === 'slow_valid') {
            check(
              after.state === 'resolved',
              `${method}: valid slow receipt was rejected: ${after.state === 'rejected' ? String(after.reason) : after.state}`,
            );
            if (
              OBJECT_CONTRACT.has(method) &&
              method !== 'startSessionCapture'
            ) {
              check(
                after.state === 'resolved' &&
                  JSON.stringify(after.value) === JSON.stringify(payload),
                `${method}: validated receipt does not equal the native payload`,
              );
            }
            return `resolved after ${delayMs}ms with the validated receipt`;
          }
          if (method === 'readTextFile') {
            // No object contract: the raw text is passed through. Recorded,
            // not judged (its consumer parses and validates the sidecar).
            return `resolved after ${delayMs}ms; raw pass-through (no contract at this boundary)`;
          }
          check(
            after.state === 'rejected',
            `${method}: malformed slow receipt ${JSON.stringify(payload)} was ACCEPTED`,
          );
          check(
            after.state === 'rejected' && after.reason instanceof Error,
            `${method}: malformed receipt rejection is not an Error`,
          );
          return `rejected malformed receipt after ${delayMs}ms`;
        }

        case 'malformed_scalar': {
          const payload =
            method === 'setCompletionStrategy'
              ? rng.pick(['FIXED', '', null, 3, 'adaptive ', undefined, {}])
              : rng.pick(MALFORMED_SCALARS);
          label(
            `${method}: resolves with malformed receipt ${String(payload)}`,
          );
          mock.mockResolvedValue(payload);
          const settled = await settlementOf(callWrapper(method));
          check(
            settled.state === 'rejected',
            `${method}: malformed receipt ${JSON.stringify(payload)} was ACCEPTED`,
          );
          check(
            settled.state === 'rejected' &&
              settled.reason instanceof Error &&
              settled.reason.message.length > 0,
            `${method}: malformed receipt rejection carries no message`,
          );
          return 'rejected malformed scalar receipt with an Error';
        }

        case 'partial': {
          const payload = validPayload(method, rng) as Record<string, unknown>;
          const paths = leafPaths(payload).filter(
            p => !p.startsWith('posterUri') && p !== 'trigger.peakMotionMs',
          );
          const dropped = rng.pick(paths);
          setPath(payload, dropped, DELETE);
          label(`${method}: partial receipt (missing ${dropped})`);
          mock.mockResolvedValue(payload);
          const settled = await settlementOf(callWrapper(method));
          const key = `${dropped}=deleted`;
          if (settled.state === 'resolved') {
            check(
              ACCEPTED_BY_DESIGN.has(key),
              `${method}: partial receipt missing REQUIRED field "${dropped}" was ACCEPTED`,
            );
            return `accepted by design (optional field ${dropped} absent)`;
          }
          check(
            settled.state === 'rejected' && settled.reason instanceof Error,
            `${method}: partial receipt rejection is not an Error`,
          );
          return `rejected partial receipt (missing ${dropped})`;
        }

        case 'poisoned': {
          const payload = validPayload(method, rng) as Record<string, unknown>;
          const paths = leafPaths(payload);
          const target = rng.pick(paths);
          const poison = rng.pick(POISONS);
          setPath(payload, target, poison.value);
          label(`${method}: poisoned receipt (${target} := ${poison.name})`);
          mock.mockResolvedValue(payload);
          const settled = await settlementOf(callWrapper(method));
          const key = `${target}=${poison.name}`;
          if (settled.state === 'resolved') {
            check(
              ACCEPTED_BY_DESIGN.has(key),
              `${method}: poisoned receipt ${key} was ACCEPTED`,
            );
            return `accepted by design (${key})`;
          }
          check(
            settled.state === 'rejected' && settled.reason instanceof Error,
            `${method}: poisoned receipt rejection is not an Error`,
          );
          return `rejected poisoned receipt (${key})`;
        }
      }
    });
    expect(broken(rows)).toEqual([]);
  });

  it('exhaustive: every poison on every field of the guided-capture receipt', async () => {
    // Deterministic sweep (not seeded — the space is small enough to walk).
    const payload = clone(automaticClip);
    const accepted: string[] = [];
    let rejected = 0;
    for (const target of leafPaths(payload)) {
      for (const poison of POISONS) {
        const mutated = clone(automaticClip) as Record<string, unknown>;
        setPath(mutated, target, poison.value);
        const key = `${target}=${poison.name}`;
        let ok = true;
        try {
          assertCapturedClip(mutated, 'automatic_pose_trigger');
        } catch {
          ok = false;
        }
        if (ok) accepted.push(key);
        else rejected += 1;
        results.push({
          campaign: 'guided-receipt-poison-sweep',
          iteration: results.length,
          seed: 0,
          scenario: key,
          outcome: ok && !ACCEPTED_BY_DESIGN.has(key) ? 'BROKEN' : 'HELD',
          detail: ok ? 'accepted' : 'rejected',
        });
      }
    }
    const unexpected = accepted.filter(key => !ACCEPTED_BY_DESIGN.has(key));
    expect(rejected).toBeGreaterThan(0);
    expect(unexpected).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Campaign 2 — malformed native events + odd fps/aspect through the envelope
// ---------------------------------------------------------------------------

function dimensionStatus(envelope: EnvelopeVerdict, dimension: string) {
  const found = envelope.dimensions.find(d => d.dimension === dimension);
  check(found !== undefined, `dimension ${dimension} missing from verdict`);
  return found!;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

interface Band {
  supportedMin?: number;
  supportedMax?: number;
  degradedMin?: number;
  degradedMax?: number;
}

const BANDS = {
  frame_rate: { supportedMin: 24, degradedMin: 15 },
  resolution: { supportedMin: 720, degradedMin: 480 },
  brightness: {
    supportedMin: 60,
    supportedMax: 200,
    degradedMin: 40,
    degradedMax: 220,
  },
  clip_duration: {
    supportedMin: 2000,
    supportedMax: 90_000,
    degradedMin: 1000,
    degradedMax: 180_000,
  },
  player_visibility: { supportedMin: 0.5, degradedMin: 0.3 },
} satisfies Record<string, Band>;

/**
 * What an honest verdict must say about one input: a value that is not a
 * finite number was never measured (NOT_MEASURED, measured=null); a finite
 * number is classified by the versioned band and echoed as `measured`.
 */
function expectHonest(
  envelope: EnvelopeVerdict,
  dimension: keyof typeof BANDS,
  input: unknown,
  scenario: string,
): void {
  const band: Band = BANDS[dimension];
  const verdict = dimensionStatus(envelope, dimension);
  if (!isFiniteNumber(input)) {
    check(
      verdict.status === 'NOT_MEASURED',
      `${scenario}: ${dimension} input ${String(input)} (${typeof input}) was classified ${verdict.status} — an unmeasurable value must be NOT_MEASURED`,
    );
    check(
      verdict.measured === null,
      `${scenario}: ${dimension} reports measured=${String(verdict.measured)} for an unmeasurable input`,
    );
    return;
  }
  const inBand = (min?: number, max?: number) =>
    (min === undefined || input >= min) && (max === undefined || input <= max);
  const expected = inBand(band.supportedMin, band.supportedMax)
    ? 'SUPPORTED'
    : inBand(band.degradedMin, band.degradedMax)
      ? 'DEGRADED'
      : 'UNSUPPORTED';
  check(
    verdict.status === expected,
    `${scenario}: ${dimension}=${input} classified ${verdict.status}, expected ${expected}`,
  );
  check(
    verdict.measured === input,
    `${scenario}: ${dimension} measured=${String(verdict.measured)} != input ${input}`,
  );
}

function expectVerdictConsistent(envelope: EnvelopeVerdict): string {
  const gate = readyGate(envelope);
  const unsupported = envelope.dimensions
    .filter(d => d.status === 'UNSUPPORTED')
    .map(d => d.dimension);
  check(
    gate.blocked === unsupported.length > 0 &&
      JSON.stringify(gate.blockingDimensions) === JSON.stringify(unsupported),
    'readyGate disagrees with the UNSUPPORTED dimensions',
  );
  const lines = captureGuidanceLines(envelope);
  const guided = envelope.dimensions.filter(
    d => d.status === 'DEGRADED' || d.status === 'UNSUPPORTED',
  );
  check(
    lines.length === guided.length && lines.every(line => line.text.length > 0),
    'guidance lines do not match the measured non-SUPPORTED dimensions',
  );
  for (const line of lines) {
    check(
      dimensionStatus(envelope, line.dimension).status === line.status,
      `guidance line for ${line.dimension} carries the wrong status`,
    );
  }
  const message = qualityBlockedMessage('Withheld.', envelope);
  check(
    message.startsWith('Withheld.') &&
      (lines.length === 0) === (message === 'Withheld.'),
    'qualityBlockedMessage dropped the reason or invented guidance',
  );
  const measured = envelope.dimensions.filter(d => d.status !== 'NOT_MEASURED');
  const worst = measured.some(d => d.status === 'UNSUPPORTED')
    ? 'UNSUPPORTED'
    : measured.some(d => d.status === 'DEGRADED')
      ? 'DEGRADED'
      : 'SUPPORTED';
  check(
    envelope.overall === worst,
    `overall=${envelope.overall}, expected ${worst}`,
  );
  check(
    envelope.overallWithCoverage ===
      (worst === 'SUPPORTED' && envelope.notMeasured.length > 0
        ? 'SUPPORTED_UNMEASURED'
        : worst),
    'overallWithCoverage hides unmeasured dimensions',
  );
  check(
    ENVELOPE_DIMENSIONS.every(d =>
      envelope.dimensions.some(v => v.dimension === d),
    ),
    'verdict is missing canonical dimensions',
  );
  return `overall=${envelope.overall} coverage=${envelope.overallWithCoverage} blocked=${gate.blocked}`;
}

// Inputs the TYPED contract admits (number | null): odd but well-formed.
const TYPED_FPS: readonly (number | null)[] = [
  0,
  0.001,
  1,
  14.999,
  15,
  23.976,
  24,
  25,
  29.97,
  30,
  47.952,
  59.94,
  60,
  120,
  240,
  960,
  1e6,
  Number.NaN,
  null,
];
const TYPED_SIZE: readonly (number | null)[] = [
  1,
  16,
  144,
  240,
  320,
  479,
  480,
  640,
  719,
  720,
  1080,
  1280,
  1920,
  2160,
  3840,
  4320,
  7680,
  1e9,
  Number.NaN,
  null,
];
const TYPED_COVERAGE: readonly number[] = [
  0,
  0.29,
  0.3,
  0.49,
  0.5,
  0.91,
  1,
  Number.NaN,
];
const TYPED_LUMA: readonly (number | null)[] = [
  0,
  5,
  40,
  128,
  200,
  220,
  255,
  300,
  Number.NaN,
  null,
];

// Inputs a MALFORMED native event can carry through the unvalidated
// `event as CameraEvent` cast (capture.ts subscribeToCameraEvents).
const MALFORMED_NUMERIC: readonly unknown[] = [
  undefined,
  '30',
  '0.9',
  '128',
  true,
  false,
  {},
  [],
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

// Values assertCapturedClip admits for a recorded clip.
const VALID_CLIP_FPS: readonly number[] = [
  0, 0.001, 1, 14.999, 15, 23.976, 24, 29.97, 30, 59.94, 60, 120, 240, 960,
];
const VALID_CLIP_SIZE: readonly number[] = [
  1, 16, 144, 240, 320, 479, 480, 640, 719, 720, 1080, 1280, 1920, 2160, 3840,
  4320, 7680, 1e9,
];
const VALID_CLIP_DURATION: readonly number[] = [
  0.1, 999, 1000, 1999, 2000, 4200, 89_999, 90_000, 90_001, 180_000, 180_001,
  1e9,
];

const READINESS_STATES = [
  'ready',
  'no_person',
  'full_body_required',
  'move_closer',
  'hold_still',
  'garbage_state',
] as const;

interface LiveInputs {
  emitReadiness: boolean;
  emitQuality: boolean;
  readinessState: string;
  coverage: unknown;
  fps: unknown;
  width: unknown;
  height: unknown;
  luma: unknown;
}

/** Delivers the inputs through the real emitter path and evaluates the live
 * envelope exactly the way AnalyzeScreen consumes the stream. */
function liveVerdictFor(inputs: LiveInputs): EnvelopeVerdict | null {
  listeners.splice(0, listeners.length);
  const buffer = createAttemptEvidenceBuffer();
  buffer.beginAttempt();
  const received: CameraEvent[] = [];
  const unsubscribe = subscribeToCameraEvents(event => received.push(event));
  check(listeners.length === 1, 'subscribeToCameraEvents did not register');
  try {
    if (inputs.emitReadiness) {
      listeners[0]!({
        type: 'readiness',
        state: inputs.readinessState,
        jointCoverage: inputs.coverage,
        poseConfidence: 0.5,
        stableForMs: 100,
        missingJoints: [],
        emittedAtIso: '2026-09-05T00:00:00.000Z',
      });
    }
    if (inputs.emitQuality) {
      listeners[0]!({
        type: 'capture_quality',
        signals: {
          schemaVersion: 1,
          frameWidthPx: inputs.width,
          frameHeightPx: inputs.height,
          avgFrameRateFps: inputs.fps,
          brightnessMeanLuma: inputs.luma,
          laplacianVarianceMedian: null,
          meanAbsFrameDiff: null,
          sampledFrameCount: 30,
        },
        emittedAtIso: '2026-09-05T00:00:00.500Z',
      });
    }
  } finally {
    unsubscribe();
  }
  check(listeners.length === 0, 'unsubscribe did not remove the listener');
  check(
    received.length ===
      Number(inputs.emitReadiness) + Number(inputs.emitQuality),
    'events were dropped or duplicated by the subscription',
  );
  for (const event of received) {
    if (event.type === 'readiness') {
      buffer.noteReadiness({
        state: event.state,
        jointCoverage: event.jointCoverage,
      });
    } else if (event.type === 'capture_quality') {
      buffer.noteQuality(event.signals);
    }
  }
  return liveCaptureEnvelope(buffer.readiness, buffer.quality);
}

function shortSideOf(width: unknown, height: unknown): unknown {
  if (width === null || height === null) return null;
  if (isFiniteNumber(width) && isFiniteNumber(height))
    return Math.min(width, height);
  return Number.NaN;
}

function assertLiveHonest(
  inputs: LiveInputs,
  envelope: EnvelopeVerdict | null,
): string {
  if (!inputs.emitReadiness && !inputs.emitQuality) {
    check(envelope === null, 'a verdict was fabricated from no evidence');
    check(
      readyGate(envelope).blocked === false,
      'readyGate blocked with no verdict',
    );
    return 'no evidence → null verdict, gate open';
  }
  check(envelope !== null, 'evidence was delivered but no verdict produced');
  const visibilityInput = inputs.emitReadiness
    ? inputs.readinessState === 'no_person'
      ? 0
      : inputs.coverage
    : null;
  expectHonest(envelope!, 'player_visibility', visibilityInput, 'live');
  expectHonest(
    envelope!,
    'frame_rate',
    inputs.emitQuality ? inputs.fps : null,
    'live',
  );
  expectHonest(
    envelope!,
    'resolution',
    inputs.emitQuality ? shortSideOf(inputs.width, inputs.height) : null,
    'live',
  );
  expectHonest(
    envelope!,
    'brightness',
    inputs.emitQuality ? inputs.luma : null,
    'live',
  );
  check(
    dimensionStatus(envelope!, 'clip_duration').status === 'NOT_MEASURED',
    'live envelope judged clip_duration before any clip exists',
  );
  return expectVerdictConsistent(envelope!);
}

describe('stress/mod-capture — malformed native events and odd fps/aspect through the envelope', () => {
  it('live envelope over typed-but-odd readiness/quality events (null, NaN, 0 fps, 1px, 1e9px)', async () => {
    const rows = await runCampaign('live-envelope-typed-odd', 2, rng => {
      const label = (rng as Rng & { label: (s: string) => void }).label;
      const inputs: LiveInputs = {
        emitReadiness: rng.bool(0.7),
        emitQuality: rng.bool(0.7),
        readinessState: rng.pick(READINESS_STATES),
        coverage: rng.pick(TYPED_COVERAGE),
        fps: rng.pick(TYPED_FPS),
        width: rng.pick(TYPED_SIZE),
        height: rng.pick(TYPED_SIZE),
        luma: rng.pick(TYPED_LUMA),
      };
      label(
        `readiness(${inputs.emitReadiness ? `${inputs.readinessState}, coverage=${String(inputs.coverage)}` : 'none'}) quality(${inputs.emitQuality ? `fps=${String(inputs.fps)} ${String(inputs.width)}x${String(inputs.height)} luma=${String(inputs.luma)}` : 'none'})`,
      );
      return assertLiveHonest(inputs, liveVerdictFor(inputs));
    });
    expect(broken(rows)).toEqual([]);
  });

  it('live envelope over MALFORMED native event fields (undefined, strings, booleans, ±Infinity) never reports a measurement nobody made', async () => {
    // Reachable: the native emitter's payload is cast, not validated, at
    // capture.ts subscribeToCameraEvents, and AnalyzeScreen forwards
    // event.jointCoverage / event.signals verbatim into the envelope.
    const rows = await runCampaign('live-envelope-malformed-events', 3, rng => {
      const label = (rng as Rng & { label: (s: string) => void }).label;
      const malformField = rng.pick([
        'coverage',
        'fps',
        'width',
        'luma',
      ] as const);
      const inputs: LiveInputs = {
        emitReadiness: malformField === 'coverage' ? true : rng.bool(0.5),
        emitQuality: malformField === 'coverage' ? rng.bool(0.5) : true,
        readinessState: rng.pick(
          READINESS_STATES.filter(s => s !== 'no_person'),
        ),
        coverage: rng.pick(TYPED_COVERAGE),
        fps: rng.pick(TYPED_FPS),
        width: rng.pick(TYPED_SIZE),
        height: rng.pick(TYPED_SIZE),
        luma: rng.pick(TYPED_LUMA),
      };
      const poison = rng.pick(MALFORMED_NUMERIC);
      inputs[malformField] = poison;
      label(
        `${malformField} := ${typeof poison === 'string' ? JSON.stringify(poison) : String(poison)} (${typeof poison}); readiness(${inputs.emitReadiness ? `${inputs.readinessState}, coverage=${String(inputs.coverage)}` : 'none'}) quality(${inputs.emitQuality ? `fps=${String(inputs.fps)} ${String(inputs.width)}x${String(inputs.height)} luma=${String(inputs.luma)}` : 'none'})`,
      );
      return assertLiveHonest(inputs, liveVerdictFor(inputs));
    });
    expect(broken(rows)).toEqual([]);
  });

  it('attempt and session-event envelopes stay honest for every fps/aspect/duration a validated clip can carry', async () => {
    const rows = await runCampaign('attempt-envelope-odd-config', 4, rng => {
      const label = (rng as Rng & { label: (s: string) => void }).label;
      const fps = rng.pick(VALID_CLIP_FPS);
      const width = rng.pick(VALID_CLIP_SIZE);
      const height = rng.pick(VALID_CLIP_SIZE);
      const durationMs = rng.pick(VALID_CLIP_DURATION);
      const coverage = rng.pick(TYPED_COVERAGE);
      label(
        `clip fps=${fps} ${width}x${height} duration=${durationMs} coverage=${String(coverage)}`,
      );
      // The clip really passes the receipt boundary with this config.
      const clip = assertCapturedClip(
        { ...clone(importedClip), fps, width, height, durationMs },
        'imported_video',
      );
      const readiness = rng.bool()
        ? { state: 'ready', jointCoverage: coverage }
        : null;
      const quality: CaptureQualitySignalsV1 | null = rng.bool()
        ? {
            schemaVersion: 1,
            // The attempt envelope must prefer the clip's REAL config over
            // preview proxies for resolution/fps.
            frameWidthPx: 8,
            frameHeightPx: 8,
            avgFrameRateFps: 1,
            brightnessMeanLuma: 128,
            laplacianVarianceMedian: null,
            meanAbsFrameDiff: null,
            sampledFrameCount: 12,
          }
        : null;
      const envelope = attemptCaptureEnvelope(clip, quality, readiness);
      expectHonest(envelope, 'frame_rate', fps, 'attempt');
      expectHonest(envelope, 'resolution', Math.min(width, height), 'attempt');
      expectHonest(envelope, 'clip_duration', durationMs, 'attempt');
      expectHonest(
        envelope,
        'player_visibility',
        readiness ? coverage : null,
        'attempt',
      );
      check(
        dimensionStatus(envelope, 'brightness').status ===
          (quality ? 'SUPPORTED' : 'NOT_MEASURED'),
        'brightness proxy did not carry over from the live window as expected',
      );
      const summary = expectVerdictConsistent(envelope);
      // Session-event clips never judge duration.
      const session = sessionEventClipEnvelope(clip);
      check(
        dimensionStatus(session, 'clip_duration').status === 'NOT_MEASURED' &&
          session.notMeasured.includes('clip_duration'),
        'session-event envelope judged clip_duration',
      );
      expectHonest(session, 'frame_rate', fps, 'session');
      expectHonest(session, 'resolution', Math.min(width, height), 'session');
      expectVerdictConsistent(session);
      return summary;
    });
    expect(broken(rows)).toEqual([]);
  });

  it('a new attempt never inherits the previous window’s evidence', async () => {
    const rows = await runCampaign('attempt-buffer-isolation', 5, rng => {
      const label = (rng as Rng & { label: (s: string) => void }).label;
      const buffer = createAttemptEvidenceBuffer();
      const notes = 1 + rng.int(6);
      label(`${notes} evidence notes then beginAttempt`);
      for (let i = 0; i < notes; i += 1) {
        if (rng.bool()) {
          buffer.noteReadiness({ state: 'ready', jointCoverage: rng.float() });
        } else {
          buffer.noteQuality({
            schemaVersion: 1,
            frameWidthPx: 720,
            frameHeightPx: 1280,
            avgFrameRateFps: 60,
            brightnessMeanLuma: 128,
            laplacianVarianceMedian: 500,
            meanAbsFrameDiff: 1,
            sampledFrameCount: 10,
          });
        }
      }
      check(
        buffer.readiness !== null || buffer.quality !== null,
        'evidence was not retained within the attempt',
      );
      buffer.beginAttempt();
      check(
        buffer.readiness === null && buffer.quality === null,
        'beginAttempt leaked evidence into the next attempt',
      );
      check(
        liveCaptureEnvelope(buffer.readiness, buffer.quality) === null,
        'a verdict was produced for a silent new window',
      );
      return 'cleared';
    });
    expect(broken(rows)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Campaign 3 — device bench: frame drops, odd fps, broken clocks
// ---------------------------------------------------------------------------

const BENCH_INIT = {
  deviceModel: 'iPhone17,1',
  osVersion: '19.0',
  appVersion: '1.0.0 (1)',
  startedAtIso: '2026-09-05T00:00:00.000Z',
};

function validBenchExport(): DeviceBenchExportV1 {
  return {
    schemaVersion: DEVICE_BENCH_SCHEMA_VERSION,
    ...BENCH_INIT,
    durationMs: 5000,
    thermal: {
      samples: [
        { tMs: 0, state: 'nominal' },
        { tMs: 2500, state: 'fair' },
      ],
      unavailableReason: null,
    },
    fps: {
      samples: [
        { tMs: 1000, fps: 59.9, windowMs: 1000 },
        { tMs: 2000, fps: 0, windowMs: 1000 },
      ],
      unavailableReason: null,
    },
    memory: { samples: [], unavailableReason: 'task_info unavailable' },
    captures: [
      {
        clipUri: 'file:///private/var/mobile/clip.mov',
        finalizedAtMs: 5000,
        completionStrategy: 'fixed',
        telemetrySchemas: ['capture-completion-v1'],
      },
    ],
    notes: ['seeded'],
  };
}

const BENCH_ACCEPTED_BY_DESIGN: ReadonlySet<string> = new Set([
  // free-form strings accept any nonempty value
  'deviceModel=garbage-string',
  'deviceModel=http-uri',
  'osVersion=garbage-string',
  'osVersion=http-uri',
  'appVersion=garbage-string',
  'appVersion=http-uri',
  'startedAtIso=garbage-string',
  'startedAtIso=http-uri',
  'memory.unavailableReason=garbage-string',
  'memory.unavailableReason=http-uri',
  'captures.0.clipUri=garbage-string',
  'captures.0.clipUri=http-uri',
  'captures.0.telemetrySchemas.0=garbage-string',
  'captures.0.telemetrySchemas.0=http-uri',
  'captures.0.telemetrySchemas.0=deleted',
  'notes.0=empty-string',
  'notes.0=garbage-string',
  'notes.0=http-uri',
  'notes.0=deleted',
  // non-negative finite numbers are legal measurements
  'durationMs=0',
  'durationMs=1.5',
  'durationMs=1e15',
  'thermal.samples.0.tMs=1.5',
  'thermal.samples.1.tMs=1e15',
  'fps.samples.0.tMs=0',
  'fps.samples.0.tMs=1.5',
  'fps.samples.1.tMs=1e15',
  'fps.samples.0.fps=0',
  'fps.samples.0.fps=1.5',
  'fps.samples.0.fps=1e15',
  'fps.samples.1.fps=1.5',
  'fps.samples.1.fps=1e15',
  'fps.samples.0.windowMs=1.5',
  'fps.samples.0.windowMs=1e15',
  'fps.samples.1.windowMs=1.5',
  'fps.samples.1.windowMs=1e15',
  'captures.0.finalizedAtMs=0',
  'captures.0.finalizedAtMs=1.5',
  'captures.0.finalizedAtMs=1e15',
  // values equal to the fixture's own, or empty arrays where the schema
  // permits them (captures/notes/telemetrySchemas may be empty; an empty
  // series is valid because the fixture already carries its reason)
  'thermal.samples.0.tMs=0',
  'thermal.samples.1.tMs=0',
  'thermal.samples.1.tMs=1.5',
  'thermal.unavailableReason=null',
  'fps.samples.1.fps=0',
  'fps.unavailableReason=null',
  'memory.samples=array',
  'captures=array',
  'captures.0.telemetrySchemas=array',
  'notes=array',
  // an array element removed leaves a still-valid shorter series
  'thermal.samples.0=deleted',
  'thermal.samples.1=deleted',
  'fps.samples.0=deleted',
  'fps.samples.1=deleted',
  'captures.0=deleted',
]);

describe('stress/mod-capture — device bench under frame drops, odd fps and broken clocks', () => {
  it('recorder never finalizes an invalid export and never fabricates missing signals', async () => {
    const rows = await runCampaign('device-bench-recorder', 6, rng => {
      const label = (rng as Rng & { label: (s: string) => void }).label;
      const recorder = new DeviceBenchRecorder(BENCH_INIT);
      const faults: string[] = [];
      let t = 0;
      const pushes = rng.int(40);
      let maxT = 0;
      let anyInvalid = false;
      const thermalCount = { n: 0 };
      const fpsCount = { n: 0 };
      const memoryCount = { n: 0 };
      for (let i = 0; i < pushes; i += 1) {
        // Frame drops show up as long gaps and 0-fps windows; broken clocks
        // as NaN / negative / backwards timestamps.
        const clockFault = rng.pick([
          'ok',
          'ok',
          'ok',
          'ok',
          'nan',
          'negative',
          'backwards',
          'infinite',
        ]);
        let tMs = t + rng.int(3000);
        if (clockFault === 'nan') tMs = Number.NaN;
        else if (clockFault === 'negative') tMs = -1 - rng.int(1000);
        else if (clockFault === 'backwards')
          tMs = Math.max(0, t - 1 - rng.int(500));
        else if (clockFault === 'infinite') tMs = Number.POSITIVE_INFINITY;
        const series = rng.pick([
          'thermal',
          'fps',
          'memory',
          'capture',
        ] as const);
        if (series === 'thermal') {
          const state = rng.pick([
            'nominal',
            'fair',
            'serious',
            'critical',
            'unknown',
            '',
          ]);
          if (!['nominal', 'fair', 'serious', 'critical'].includes(state)) {
            faults.push(`thermal.state=${state}`);
            anyInvalid = true;
          }
          recorder.pushThermal({ tMs, state: state as 'nominal' });
          thermalCount.n += 1;
        } else if (series === 'fps') {
          const fps = rng.pick([
            0,
            0.5,
            15,
            24,
            29.97,
            59.94,
            120,
            240,
            -1,
            Number.NaN,
            Number.POSITIVE_INFINITY,
          ]);
          const windowMs = rng.pick([1000, 500, 16.7, 0, -100, Number.NaN]);
          if (!(Number.isFinite(fps) && fps >= 0)) {
            faults.push(`fps=${fps}`);
            anyInvalid = true;
          }
          if (!(Number.isFinite(windowMs) && windowMs > 0)) {
            faults.push(`windowMs=${windowMs}`);
            anyInvalid = true;
          }
          recorder.pushFps({ tMs, fps, windowMs });
          fpsCount.n += 1;
        } else if (series === 'memory') {
          const footprintBytes = rng.pick([0, 1e6, 512e6, 3e9, -1, Number.NaN]);
          if (!(Number.isFinite(footprintBytes) && footprintBytes >= 0)) {
            faults.push(`footprint=${footprintBytes}`);
            anyInvalid = true;
          }
          recorder.pushMemory({ tMs, footprintBytes });
          memoryCount.n += 1;
        } else {
          recorder.pushCapture({
            clipUri: `file:///private/var/mobile/clip-${i}.mov`,
            finalizedAtMs: tMs,
            completionStrategy: rng.pick(['fixed', 'adaptive']),
            telemetrySchemas: ['capture-completion-v1'],
          });
        }
        if (clockFault !== 'ok') {
          faults.push(`${series}.tMs=${clockFault}`);
          anyInvalid = true;
        } else {
          t = tMs;
          maxT = Math.max(maxT, tMs);
        }
      }
      const explain = rng.bool(0.6);
      const reasons = explain
        ? {
            thermal: 'thermal state unavailable',
            fps: 'fps sampler unavailable',
            memory: 'task_info unavailable',
          }
        : {};
      const emptyUnexplained =
        !explain &&
        (thermalCount.n === 0 || fpsCount.n === 0 || memoryCount.n === 0);
      label(
        `${pushes} pushes, faults=[${faults.join(',')}], reasons=${explain ? 'given' : 'omitted'}`,
      );
      let doc: DeviceBenchExportV1 | null = null;
      let thrown: unknown = null;
      try {
        doc = recorder.finalize(reasons);
      } catch (error) {
        thrown = error;
      }
      if (anyInvalid || emptyUnexplained) {
        check(
          doc === null,
          `an export with faults [${faults.join(',')}]${emptyUnexplained ? ' and an unexplained empty series' : ''} was FINALIZED`,
        );
        check(
          thrown instanceof Error &&
            /device-bench export invalid/.test(thrown.message),
          `finalize threw a non-descriptive error: ${String(thrown)}`,
        );
        return `refused (${faults.length} faults${emptyUnexplained ? ', unexplained empty series' : ''})`;
      }
      check(
        doc !== null,
        `a fault-free recording failed to finalize: ${String(thrown)}`,
      );
      const errors = validateDeviceBenchExport(JSON.parse(JSON.stringify(doc)));
      check(
        errors.length === 0,
        `finalized export re-validates with errors: ${errors.join('; ')}`,
      );
      check(
        doc!.durationMs === maxT,
        `durationMs=${doc!.durationMs} != max observed ${maxT}`,
      );
      for (const key of ['thermal', 'fps', 'memory'] as const) {
        const series = doc![key];
        if (series.samples.length === 0) {
          check(
            typeof series.unavailableReason === 'string' &&
              series.unavailableReason.length > 0,
            `${key}: empty series without a reason was exported`,
          );
        } else {
          check(
            series.unavailableReason === null,
            `${key}: reason attached to a measured series`,
          );
        }
      }
      check(
        doc!.fps.samples.every(s => Number.isFinite(s.fps)),
        'a non-finite fps sample survived into the export',
      );
      check(
        deviceBenchExportFilename(doc!.startedAtIso).endsWith('.json') &&
          !/[:.]/.test(
            deviceBenchExportFilename(doc!.startedAtIso).slice(0, -5),
          ),
        'export filename is not filesystem-safe',
      );
      return `finalized ${pushes} samples, durationMs=${doc!.durationMs}`;
    });
    expect(broken(rows)).toEqual([]);
  });

  it('exhaustive: every poison on every field of a valid export is reported at its path', () => {
    const accepted: string[] = [];
    let rejected = 0;
    for (const target of leafPaths(validBenchExport())) {
      for (const poison of POISONS) {
        const mutated = validBenchExport() as unknown as Record<
          string,
          unknown
        >;
        setPath(mutated, target, poison.value);
        const key = `${target}=${poison.name}`;
        const errors = validateDeviceBenchExport(mutated);
        const ok = errors.length === 0;
        if (ok) accepted.push(key);
        else {
          rejected += 1;
          // Every error names the offending region so a human can find it.
          const root = target.split('.')[0] as string;
          const located = errors.some(
            e => e.startsWith(root) || e.startsWith('document'),
          );
          results.push({
            campaign: 'device-bench-poison-sweep',
            iteration: results.length,
            seed: 0,
            scenario: key,
            outcome: located ? 'HELD' : 'BROKEN',
            detail: located
              ? `rejected: ${errors[0]}`
              : `rejected but error not located: ${errors.join('; ')}`,
          });
          expect(located).toBe(true);
          continue;
        }
        results.push({
          campaign: 'device-bench-poison-sweep',
          iteration: results.length,
          seed: 0,
          scenario: key,
          outcome: BENCH_ACCEPTED_BY_DESIGN.has(key) ? 'HELD' : 'BROKEN',
          detail: 'accepted',
        });
      }
    }
    const unexpected = accepted.filter(
      key => !BENCH_ACCEPTED_BY_DESIGN.has(key),
    );
    expect(rejected).toBeGreaterThan(0);
    expect(unexpected).toEqual([]);
  });
});
