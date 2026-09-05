/**
 * SEEDED RANDOMIZED LONG-RUN harness for the `mod-capture` unit:
 *   apps/mobile/src/camera/capture.ts         (native boundary + validators)
 *   apps/mobile/src/camera/captureEnvelope.ts (envelope / guidance / gate)
 *   apps/mobile/src/camera/deviceBench.ts     (bench recorder + validator)
 *
 * Every sequence is derived from a single 32-bit seed: `generateActions(seed)`
 * yields 5–60 legal/near-legal actions over the PUBLIC API, `runActions`
 * executes them against the real modules (only `react-native` is replaced by
 * the simulated bridge in test-support/stress/simulatedBridge.ts) and checks
 * the model invariants below after EVERY action. A failing sequence is
 * shrunk with ddmin over its action list (`minimizeActions`), and the
 * determinism check re-runs the seed and compares the full step trace.
 *
 * INVARIANTS (I-xx) — each is documented in the production source; the
 * comment references point at the contract being checked:
 *
 *  Boundary (capture.ts)
 *  I-AV   cameraAvailable/sessionCaptureAvailable/videoImportAvailable/
 *         importedPoseExtractionAvailable ⇔ exact bridge-method presence
 *         (capture.ts `cameraAvailable`, `sessionCaptureAvailable` doc).
 *  I-UNAV a missing bridge method ⇒ the public op rejects with the
 *         documented "not available" message and makes NO native call.
 *  I-CLIP assertCapturedClip / captureStrokeVideo / importStrokeVideo /
 *         extractSessionEventClip accept a contract-legal payload UNCHANGED
 *         (same reference, no repair) and reject EVERY contract-invalid
 *         payload with the invalid-clip error ("rejected, never repaired").
 *  I-MODE a payload of the other captureMode is rejected by the mode-typed
 *         entry points.
 *  I-ERR  native rejections propagate as the SAME error object (codes kept —
 *         `extractImportedPoseSequence` doc), including permission denial.
 *  I-SESS startSessionCapture returns exactly {sessionCaptureId} on a valid
 *         receipt, rejects otherwise, and records exactly ONE stabilitySlo
 *         event whose kind/reason matches the branch taken.
 *  I-REQ  session-clip / pose-extraction / strategy / stop requests reach
 *         the bridge VERBATIM (bounds carried verbatim; seed omitted when
 *         null/undefined; seed outside [0,1] rejected before any native call).
 *  I-POSE assertImportedPoseExtraction projects exactly {poseSequence,
 *         posterUri?, framesWithPose, framesTotal} and rejects invalid receipts.
 *  I-STRAT setCaptureCompletionStrategy returns the applied strategy only if
 *         it is a known one; otherwise rejects (no silent default).
 *  I-EVT  every live subscriber receives every emitted event exactly once,
 *         unsubscribed listeners receive nothing, unsubscribe is idempotent.
 *  I-CANCEL cancelCameraOperation calls native cancel exactly once when
 *         present and never throws when absent.
 *
 *  Envelope (captureEnvelope.ts + packages/capture-envelope)
 *  I-ENV  liveCaptureEnvelope(null,null) === null; otherwise every verdict
 *         equals an INDEPENDENT oracle (thresholds table below): 13 canonical
 *         dimensions in order, null/NaN ⇒ NOT_MEASURED with measured null,
 *         overall = worst measured, overallWithCoverage =
 *         SUPPORTED_UNMEASURED iff worst SUPPORTED and something unmeasured.
 *  I-BUF  beginAttempt clears readiness and quality; notes replace.
 *  I-SESSENV sessionEventClipEnvelope never judges clip_duration.
 *  I-GUIDE guidance lines = exactly the measured DEGRADED/UNSUPPORTED
 *         dimensions in canonical order, non-empty policy-clean copy,
 *         identical text for identical (dimension,status).
 *  I-BLOCK qualityBlockedMessage === reason when no lines, else
 *         reason + "\n\n" + "• line" per guidance line.
 *  I-GATE readyGate blocks ⇔ ≥1 UNSUPPORTED; DEGRADED never blocks.
 *  I-PURE envelope functions never mutate their inputs.
 *
 *  Device bench (deviceBench.ts)
 *  I-BENCH finalize() output equals an independent model of the recorder
 *         (series copied in push order, durationMs = greatest finite
 *         observed timestamp, empty series carry the given reason, populated
 *         series carry null) and validates clean; finalize() THROWS whenever
 *         the model finds a contract violation ("throws rather than emit an
 *         invalid document"), naming every violated path.
 *  I-BENCHV validateDeviceBenchExport never throws on junk and flags exactly
 *         the injected violation(s).
 *  I-BENCHCOPY mutating a returned document does not alter later exports.
 *  I-FNAME deviceBenchExportFilename is deterministic, filesystem-safe and
 *         injective on ISO timestamps.
 *
 * Nothing here claims camera, AVFoundation, Vision, thermal or FPS behaviour
 * of a device — every "device" here is the simulated bridge.
 */
import {
  assertCapturedClip,
  cameraAvailable,
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  extractSessionEventClip,
  importStrokeVideo,
  importedPoseExtractionAvailable,
  sessionCaptureAvailable,
  setCaptureCompletionStrategy,
  startSessionCapture,
  stopSessionCapture,
  subscribeToCameraEvents,
  videoImportAvailable,
  type CapturedClip,
  type CaptureQualitySignalsV1,
  type SessionEventClipBounds,
} from '../../src/camera/capture';
import {
  attemptCaptureEnvelope,
  captureGuidanceLines,
  createAttemptEvidenceBuffer,
  liveCaptureEnvelope,
  qualityBlockedMessage,
  readyGate,
  sessionEventClipEnvelope,
  type AttemptEvidenceBuffer,
  type ReadinessSnapshot,
} from '../../src/camera/captureEnvelope';
import {
  DEVICE_BENCH_SCHEMA_VERSION,
  DeviceBenchRecorder,
  deviceBenchExportFilename,
  validateDeviceBenchExport,
  type DeviceBenchCaptureRefV1,
  type DeviceBenchRecorderInit,
  type FpsSampleV1,
  type MemorySampleV1,
  type ThermalSampleV1,
} from '../../src/camera/deviceBench';
import type { EnvelopeVerdict } from '@pickle/shared-types';
import type { StabilityRecorder } from '../../src/analysis/stabilityTelemetry';
import {
  legalClip,
  legalPoseExtraction,
  mutateClip,
  POSE_EXTRACTION_MUTATIONS,
  type ClipMode,
  type Payload,
} from './captureClipGen';
import { createSeededRng, deriveSeed, type SeededRng } from './seededRng';
import {
  BRIDGE_METHODS,
  type BridgeMethodName,
  type SimulatedBridge,
} from './simulatedBridge';

// ─── Stable serialisation / deep equality ────────────────────────────────────

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return '__NaN__';
      if (v === Number.POSITIVE_INFINITY) return '__Infinity__';
      if (v === Number.NEGATIVE_INFINITY) return '__-Infinity__';
      if (Object.is(v, -0)) return '__-0__';
    }
    if (v === undefined) return '__undefined__';
    if (typeof v === 'function') return '__function__';
    if (typeof v === 'bigint') return `__bigint__${v.toString()}`;
    return v;
  });
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra)
    .filter(k => ra[k] !== undefined)
    .sort();
  const kb = Object.keys(rb)
    .filter(k => rb[k] !== undefined)
    .sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && deepEqual(ra[k], rb[k]));
}

function short(value: unknown, max = 160): string {
  const text = stableJson(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ─── Envelope oracle (independent of packages/capture-envelope) ─────────────

export const ORACLE_DIMENSIONS = [
  'resolution',
  'frame_rate',
  'brightness',
  'exposure_clipping',
  'exposure_stability',
  'motion_blur',
  'sensor_noise',
  'camera_motion',
  'camera_shake',
  'timing_stability',
  'clip_duration',
  'player_pixel_height',
  'player_visibility',
] as const;
type OracleDimension = (typeof ORACLE_DIMENSIONS)[number];

interface Band {
  min?: number;
  max?: number;
}

/** capture-envelope-thresholds-v0.1-provisional, transcribed by hand. */
const ORACLE_BANDS: Record<
  OracleDimension,
  { supported: Band; degraded: Band }
> = {
  resolution: { supported: { min: 720 }, degraded: { min: 480 } },
  frame_rate: { supported: { min: 24 }, degraded: { min: 15 } },
  brightness: {
    supported: { min: 60, max: 200 },
    degraded: { min: 40, max: 220 },
  },
  exposure_clipping: { supported: { max: 0.3 }, degraded: { max: 0.6 } },
  exposure_stability: { supported: { max: 40 }, degraded: { max: 80 } },
  motion_blur: { supported: { min: 100 }, degraded: { min: 30 } },
  sensor_noise: { supported: { min: 0.25 }, degraded: { min: 0.15 } },
  camera_motion: { supported: { max: 33 }, degraded: { max: 46 } },
  camera_shake: { supported: { max: 0.18 }, degraded: { max: 0.45 } },
  timing_stability: { supported: { max: 0.15 }, degraded: { max: 0.35 } },
  clip_duration: {
    supported: { min: 2000, max: 90_000 },
    degraded: { min: 1000, max: 180_000 },
  },
  player_pixel_height: { supported: { min: 0.25 }, degraded: { min: 0.12 } },
  player_visibility: { supported: { min: 0.5 }, degraded: { min: 0.3 } },
};

type OracleStatus = 'SUPPORTED' | 'DEGRADED' | 'UNSUPPORTED' | 'NOT_MEASURED';

function inBand(value: number, band: Band): boolean {
  return (
    (band.min === undefined || value >= band.min) &&
    (band.max === undefined || value <= band.max)
  );
}

function oracleStatus(
  value: number | null,
  dim: OracleDimension,
): OracleStatus {
  if (value === null || Number.isNaN(value)) return 'NOT_MEASURED';
  const bands = ORACLE_BANDS[dim];
  if (inBand(value, bands.supported)) return 'SUPPORTED';
  if (inBand(value, bands.degraded)) return 'DEGRADED';
  return 'UNSUPPORTED';
}

export interface OracleVerdict {
  dimensions: Array<{
    dimension: OracleDimension;
    status: OracleStatus;
    measured: number | null;
  }>;
  overall: 'SUPPORTED' | 'DEGRADED' | 'UNSUPPORTED';
  overallWithCoverage:
    'SUPPORTED' | 'DEGRADED' | 'UNSUPPORTED' | 'SUPPORTED_UNMEASURED';
  notMeasured: OracleDimension[];
}

type OracleInputs = Partial<Record<OracleDimension, number | null>>;

export function oracleVerdict(inputs: OracleInputs): OracleVerdict {
  const severity = { SUPPORTED: 0, DEGRADED: 1, UNSUPPORTED: 2 } as const;
  let worst: OracleVerdict['overall'] = 'SUPPORTED';
  const notMeasured: OracleDimension[] = [];
  const dimensions = ORACLE_DIMENSIONS.map(dimension => {
    const raw = inputs[dimension] ?? null;
    const status = oracleStatus(raw, dimension);
    if (status === 'NOT_MEASURED') notMeasured.push(dimension);
    else if (severity[status] > severity[worst]) worst = status;
    return {
      dimension,
      status,
      measured: status === 'NOT_MEASURED' ? null : raw,
    };
  });
  return {
    dimensions,
    overall: worst,
    overallWithCoverage:
      worst === 'SUPPORTED' && notMeasured.length > 0
        ? 'SUPPORTED_UNMEASURED'
        : worst,
    notMeasured,
  };
}

function resolutionOf(w: number | null, h: number | null): number | null {
  if (w === null || h === null) return null;
  return Math.min(w, h);
}

function visibilityOf(readiness: ReadinessSnapshot | null): number | null {
  if (!readiness) return null;
  return readiness.state === 'no_person' ? 0 : readiness.jointCoverage;
}

function qualityInputs(quality: CaptureQualitySignalsV1 | null): OracleInputs {
  return {
    resolution: resolutionOf(
      quality?.frameWidthPx ?? null,
      quality?.frameHeightPx ?? null,
    ),
    frame_rate: quality?.avgFrameRateFps ?? null,
    brightness: quality?.brightnessMeanLuma ?? null,
    motion_blur: quality?.laplacianVarianceMedian ?? null,
    camera_motion: quality?.meanAbsFrameDiff ?? null,
  };
}

function projectVerdict(verdict: EnvelopeVerdict): OracleVerdict {
  return {
    dimensions: verdict.dimensions.map(d => ({
      dimension: d.dimension,
      status: d.status,
      measured: d.measured,
    })),
    overall: verdict.overall,
    overallWithCoverage: verdict.overallWithCoverage,
    notMeasured: [...verdict.notMeasured],
  };
}

const POLICY_FORBIDDEN = [
  'android',
  'google play',
  'guest mode',
  'live court',
  'dupr',
  'swingvision',
  'pb vision',
  'selkirk',
  'joola',
  '%',
  'best-in-class',
  'world-class',
  'ai coach',
  'accurac',
];

// ─── Device-bench oracle ─────────────────────────────────────────────────────

interface BenchModel {
  init: DeviceBenchRecorderInit;
  thermal: ThermalSampleV1[];
  fps: FpsSampleV1[];
  memory: MemorySampleV1[];
  captures: DeviceBenchCaptureRefV1[];
  notes: string[];
  lastTMs: number;
}

function observeT(model: BenchModel, tMs: number): void {
  if (Number.isFinite(tMs) && tMs > model.lastTMs) model.lastTMs = tMs;
}

interface BenchReasons {
  thermal?: string;
  fps?: string;
  memory?: string;
}

function modelDocument(model: BenchModel, reasons: BenchReasons): Payload {
  const series = <T>(samples: T[], reason: string | undefined) => ({
    samples: [...samples],
    unavailableReason: samples.length === 0 ? (reason ?? null) : null,
  });
  return {
    schemaVersion: DEVICE_BENCH_SCHEMA_VERSION,
    startedAtIso: model.init.startedAtIso,
    durationMs: model.lastTMs,
    deviceModel: model.init.deviceModel,
    osVersion: model.init.osVersion,
    appVersion: model.init.appVersion,
    thermal: series(model.thermal, reasons.thermal),
    fps: series(model.fps, reasons.fps),
    memory: series(model.memory, reasons.memory),
    captures: [...model.captures],
    notes: [...model.notes],
  };
}

const THERMAL_STATES = new Set(['nominal', 'fair', 'serious', 'critical']);
const STRATEGIES = new Set(['fixed', 'adaptive']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonNegFinite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Path prefixes (text before ':') of every problem the contract defines. */
function oracleBenchProblems(
  model: BenchModel,
  reasons: BenchReasons,
): string[] {
  const problems: string[] = [];
  for (const key of [
    'startedAtIso',
    'deviceModel',
    'osVersion',
    'appVersion',
  ] as const) {
    if (!isNonEmptyString(model.init[key])) problems.push(key);
  }
  const series = (
    label: 'thermal' | 'fps' | 'memory',
    samples: Array<{ tMs: number }>,
    reason: string | undefined,
    perSample: (s: unknown, i: number) => void,
  ) => {
    if (samples.length === 0) {
      if (!isNonEmptyString(reason)) problems.push(label);
    }
    let last = Number.NEGATIVE_INFINITY;
    samples.forEach((sample, i) => {
      if (!nonNegFinite(sample.tMs)) {
        problems.push(`${label}.samples[${i}].tMs`);
      } else {
        if (sample.tMs < last) problems.push(`${label}.samples[${i}].tMs`);
        last = sample.tMs;
      }
      perSample(sample, i);
    });
  };
  series('thermal', model.thermal, reasons.thermal, (s, i) => {
    if (!THERMAL_STATES.has((s as ThermalSampleV1).state)) {
      problems.push(`thermal.samples[${i}].state`);
    }
  });
  series('fps', model.fps, reasons.fps, (s, i) => {
    const sample = s as FpsSampleV1;
    if (!nonNegFinite(sample.fps)) problems.push(`fps.samples[${i}].fps`);
    if (!(Number.isFinite(sample.windowMs) && sample.windowMs > 0)) {
      problems.push(`fps.samples[${i}].windowMs`);
    }
  });
  series('memory', model.memory, reasons.memory, (s, i) => {
    if (!nonNegFinite((s as MemorySampleV1).footprintBytes)) {
      problems.push(`memory.samples[${i}].footprintBytes`);
    }
  });
  model.captures.forEach((capture, i) => {
    if (!isNonEmptyString(capture.clipUri))
      problems.push(`captures[${i}].clipUri`);
    if (!nonNegFinite(capture.finalizedAtMs))
      problems.push(`captures[${i}].finalizedAtMs`);
    if (!STRATEGIES.has(capture.completionStrategy)) {
      problems.push(`captures[${i}].completionStrategy`);
    }
    if (
      !Array.isArray(capture.telemetrySchemas) ||
      !capture.telemetrySchemas.every(isNonEmptyString)
    ) {
      problems.push(`captures[${i}].telemetrySchemas`);
    }
  });
  return problems.sort();
}

function errorPrefixes(errors: string[]): string[] {
  return errors.map(e => e.split(':')[0] ?? e).sort();
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type ScriptedResponse =
  | {
      kind: 'payload';
      payload: Payload;
      mode: ClipMode;
      applied: string[];
      expectInvalid: boolean;
    }
  | { kind: 'junk'; value: unknown }
  | { kind: 'reject'; code: string; message: string };

export type Action =
  | { kind: 'subscribe' }
  | { kind: 'unsubscribe'; slot: number; twice: boolean }
  | { kind: 'emit'; event: Payload }
  | { kind: 'beginAttempt' }
  | { kind: 'evaluateLive' }
  | {
      kind: 'evaluateAttempt';
      clip: { width: number; height: number; fps: number; durationMs: number };
    }
  | {
      kind: 'evaluateSessionClip';
      clip: { width: number; height: number; fps: number };
    }
  | { kind: 'guidance' }
  | { kind: 'blockedMessage'; reason: string }
  | { kind: 'readyGate' }
  | { kind: 'nativeCapture'; response: ScriptedResponse }
  | { kind: 'nativeImport'; response: ScriptedResponse }
  | {
      kind: 'assertClip';
      response: Extract<ScriptedResponse, { kind: 'payload' | 'junk' }>;
      expectedMode: ClipMode | null;
    }
  | { kind: 'sessionStart'; receipt: unknown; valid: boolean; reject: boolean }
  | { kind: 'sessionStop'; id: string | null }
  | {
      kind: 'sessionExtract';
      bounds: SessionEventClipBounds;
      response: ScriptedResponse;
    }
  | {
      kind: 'importPoseExtract';
      seed: { x: number; y: number } | null | undefined;
      seedValid: boolean;
      response:
        | {
            kind: 'receipt';
            receipt: Payload;
            applied: string[];
            expectInvalid: boolean;
          }
        | { kind: 'reject'; code: string; message: string };
    }
  | {
      kind: 'setStrategy';
      strategy: 'fixed' | 'adaptive';
      applied: unknown;
      reject: boolean;
    }
  | { kind: 'cancel' }
  | { kind: 'toggleMethod'; method: BridgeMethodName; present: boolean }
  | { kind: 'benchNew'; init: DeviceBenchRecorderInit }
  | { kind: 'benchPushThermal'; sample: ThermalSampleV1 }
  | { kind: 'benchPushFps'; sample: FpsSampleV1 }
  | { kind: 'benchPushMemory'; sample: MemorySampleV1 }
  | { kind: 'benchCapture'; capture: DeviceBenchCaptureRefV1 }
  | { kind: 'benchNote'; note: string }
  | { kind: 'benchFinalize'; reasons: BenchReasons }
  | { kind: 'benchValidate'; mutation: string }
  | { kind: 'benchFilename'; iso: string };

export type ActionKind = Action['kind'];

export const ACTION_KINDS: readonly ActionKind[] = [
  'subscribe',
  'unsubscribe',
  'emit',
  'beginAttempt',
  'evaluateLive',
  'evaluateAttempt',
  'evaluateSessionClip',
  'guidance',
  'blockedMessage',
  'readyGate',
  'nativeCapture',
  'nativeImport',
  'assertClip',
  'sessionStart',
  'sessionStop',
  'sessionExtract',
  'importPoseExtract',
  'setStrategy',
  'cancel',
  'toggleMethod',
  'benchNew',
  'benchPushThermal',
  'benchPushFps',
  'benchPushMemory',
  'benchCapture',
  'benchNote',
  'benchFinalize',
  'benchValidate',
  'benchFilename',
];

export const MIN_SEQUENCE_LENGTH = 5;
export const MAX_SEQUENCE_LENGTH = 60;

const NUMERIC_EDGE = [
  0,
  -0,
  -1,
  1e-9,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function genNumberish(rng: SeededRng, legal: readonly number[]): number {
  return rng.chance(0.75) ? rng.pick(legal) : rng.pick(NUMERIC_EDGE);
}

const QUALITY_PX = [1, 479, 480, 481, 719, 720, 721, 1080, 1920, 2160, 4000];
const QUALITY_FPS = [
  0, 0.5, 14.999, 15, 23.999, 24, 29.97, 30, 59.94, 60, 120, 240,
];
const QUALITY_LUMA = [
  0, 39.99, 40, 59.99, 60, 128, 200, 200.01, 220, 220.01, 255,
];
const QUALITY_LAPLACIAN = [0, 29.99, 30, 99.99, 100, 512, 5000];
const QUALITY_DIFF = [0, 12, 33, 33.01, 46, 46.01, 255];
const CLIP_DURATIONS = [
  1, 999, 1000, 1999.99, 2000, 5000, 90_000, 90_000.01, 180_000, 180_001,
];

function genQuality(rng: SeededRng): CaptureQualitySignalsV1 {
  const maybe = (legal: readonly number[]) =>
    rng.chance(0.25) ? null : genNumberish(rng, legal);
  return {
    schemaVersion: 1,
    frameWidthPx: maybe(QUALITY_PX),
    frameHeightPx: maybe(QUALITY_PX),
    avgFrameRateFps: maybe(QUALITY_FPS),
    brightnessMeanLuma: maybe(QUALITY_LUMA),
    laplacianVarianceMedian: maybe(QUALITY_LAPLACIAN),
    meanAbsFrameDiff: maybe(QUALITY_DIFF),
    sampledFrameCount: rng.int(0, 120),
  };
}

const READINESS_STATES = [
  'no_person',
  'full_body_required',
  'move_closer',
  'move_farther',
  'hold_still',
  'ready',
] as const;
const COVERAGE = [0, 0.1, 0.29, 0.3, 0.31, 0.49, 0.5, 0.51, 0.99, 1];

function genEvent(rng: SeededRng): Payload {
  const base: Payload = {
    emittedAtIso: new Date(
      Date.UTC(2026, 0, 1) + rng.int(0, 1e9),
    ).toISOString(),
  };
  if (rng.chance(0.5)) base.captureId = `cap-${rng.hex(6)}`;
  switch (rng.int(0, 9)) {
    case 0:
      return {
        ...base,
        type: 'permission',
        state: rng.pick(['requesting', 'granted', 'denied']),
      };
    case 1:
      return {
        ...base,
        type: 'session',
        state: rng.pick([
          'configured',
          'starting',
          'composing',
          'observing',
          'recording_started',
          'recording_stopped',
          'manual_stop_requested',
          'manual_stop_no_motion',
          'armed',
          'disarmed',
          'interrupted',
          'interruption_ended',
          'stopped',
        ]),
        ...(rng.chance(0.4)
          ? {
              reason: rng.pick([
                'shutter',
                'spool_restart',
                'observation_timeout',
                'user_stopped',
              ]),
            }
          : {}),
      };
    case 2:
    case 3:
    case 4:
      return {
        ...base,
        type: 'readiness',
        state: rng.pick(READINESS_STATES),
        poseConfidence: genNumberish(rng, COVERAGE),
        jointCoverage: genNumberish(rng, COVERAGE),
        stableForMs: rng.int(0, 5000),
        missingJoints: rng.chance(0.5)
          ? []
          : ['left_ankle', 'right_wrist'].slice(0, rng.int(1, 2)),
        source: rng.pick([
          'apple_vision_body_pose',
          'mediapipe_pose_landmarker',
        ]),
        modelVersion: `pose-v${rng.int(1, 5)}`,
      };
    case 5:
    case 6:
      return { ...base, type: 'capture_quality', signals: genQuality(rng) };
    case 7:
      return { ...base, type: 'processing', state: 'preparing_clip' };
    case 8:
      return {
        ...base,
        type: 'abstained',
        reason: rng.pick(['no_swing', 'low_confidence']),
        ...(rng.chance(0.5) ? { message: 'No swing found.' } : {}),
      };
    default:
      return {
        ...base,
        type: 'import_pose_extraction',
        state: rng.pick(['extracting', 'completed', 'failed']),
        ...(rng.chance(0.5) ? { progress: rng.float() } : {}),
      };
  }
}

const NATIVE_ERRORS: ReadonlyArray<{ code: string; message: string }> = [
  { code: 'camera.permission_denied', message: 'Camera permission denied' },
  { code: 'camera.unavailable', message: 'Camera unavailable' },
  { code: 'camera.cancelled', message: 'Capture cancelled' },
  { code: 'camera.import_too_long', message: 'Imported video too long' },
  { code: 'camera.import_no_person', message: 'No person found' },
  { code: 'camera.session_interrupted', message: 'Session interrupted' },
  { code: 'camera.disk_full', message: 'Not enough storage' },
];

function genClipResponse(rng: SeededRng, mode: ClipMode): ScriptedResponse {
  const roll = rng.int(0, 9);
  if (roll <= 3) {
    return {
      kind: 'payload',
      payload: legalClip(rng, mode),
      mode,
      applied: [],
      expectInvalid: false,
    };
  }
  if (roll <= 7) {
    const mutated = mutateClip(rng, legalClip(rng, mode), mode);
    return {
      kind: 'payload',
      payload: mutated.payload,
      mode,
      applied: mutated.applied,
      expectInvalid: mutated.expectInvalid,
    };
  }
  if (roll === 8) {
    return {
      kind: 'junk',
      value: rng.pick([null, undefined, 'clip', 42, [], true]),
    };
  }
  return { kind: 'reject', ...rng.pick(NATIVE_ERRORS) };
}

const SEED_EDGES: ReadonlyArray<{ x: number; y: number; valid: boolean }> = [
  { x: 0, y: 0, valid: true },
  { x: 1, y: 1, valid: true },
  { x: -0, y: 0.5, valid: true },
  { x: 0.5, y: 0.5, valid: true },
  { x: 1.0000001, y: 0.5, valid: false },
  { x: 0.5, y: -1e-9, valid: false },
  { x: Number.NaN, y: 0.5, valid: false },
  { x: 0.5, y: Number.POSITIVE_INFINITY, valid: false },
  { x: 2, y: 0, valid: false },
];

const BENCH_T_STEP = [0, 1, 16, 33, 100, 1000];

interface GenState {
  liveSubscribers: number;
  benchT: number;
  /** Half the sequences feed the recorder only legal samples so finalize()'s
   * success path (document shape, copies, durations) is exercised as often
   * as its rejection path. */
  benchClean: boolean;
}

export function generateAction(rng: SeededRng, state: GenState): Action {
  const kind = rng.pick(ACTION_KINDS);
  switch (kind) {
    case 'subscribe':
      if (state.liveSubscribers >= 6) return generateAction(rng, state);
      state.liveSubscribers += 1;
      return { kind };
    case 'unsubscribe':
      if (state.liveSubscribers === 0) return { kind: 'subscribe' };
      state.liveSubscribers -= 1;
      return { kind, slot: rng.int(0, 7), twice: rng.chance(0.3) };
    case 'emit':
      return { kind, event: genEvent(rng) };
    case 'beginAttempt':
    case 'evaluateLive':
    case 'guidance':
    case 'readyGate':
    case 'cancel':
      return { kind };
    case 'evaluateAttempt': {
      const [width, height] = rng.pick([
        [1920, 1080],
        [1080, 1920],
        [480, 640],
        [479, 4000],
        [1, 1],
        [100, 4000],
        [720, 720],
        [3840, 2160],
      ]) as [number, number];
      return {
        kind,
        clip: {
          width: rng.chance(0.9) ? width : rng.pick(NUMERIC_EDGE),
          height,
          fps: genNumberish(rng, QUALITY_FPS),
          durationMs: genNumberish(rng, CLIP_DURATIONS),
        },
      };
    }
    case 'evaluateSessionClip': {
      const [width, height] = rng.pick([
        [1920, 1080],
        [480, 640],
        [479, 4000],
        [1, 1],
        [100, 4000],
        [720, 720],
      ]) as [number, number];
      return {
        kind,
        clip: { width, height, fps: genNumberish(rng, QUALITY_FPS) },
      };
    }
    case 'blockedMessage':
      return {
        kind,
        reason: rng.pick([
          'Analysis withheld: capture quality was below the supported range.',
          'Could not read the swing.',
          'x',
        ]),
      };
    case 'nativeCapture':
      return { kind, response: genClipResponse(rng, 'automatic_pose_trigger') };
    case 'nativeImport':
      return { kind, response: genClipResponse(rng, 'imported_video') };
    case 'assertClip': {
      const mode: ClipMode = rng.pick([
        'automatic_pose_trigger',
        'imported_video',
      ]);
      let response = genClipResponse(rng, mode);
      while (response.kind === 'reject') response = genClipResponse(rng, mode);
      const expectedMode = rng.pick([
        null,
        mode,
        mode === 'imported_video' ? 'automatic_pose_trigger' : 'imported_video',
      ] as const);
      return { kind, response, expectedMode };
    }
    case 'sessionStart': {
      const roll = rng.int(0, 6);
      if (roll <= 2) {
        const receipt: Payload = { sessionCaptureId: `sc-${rng.hex(8)}` };
        if (rng.chance(0.4)) receipt.startedAtMs = rng.int(0, 1e6);
        return { kind, receipt, valid: true, reject: false };
      }
      if (roll === 6)
        return { kind, receipt: undefined, valid: false, reject: true };
      return {
        kind,
        receipt: rng.pick([
          { sessionCaptureId: '' },
          { sessionCaptureId: 42 },
          {},
          null,
          'sc-1',
          [],
          { sessionCaptureID: 'sc-1' },
        ]),
        valid: false,
        reject: false,
      };
    }
    case 'sessionStop':
      return {
        kind,
        id: rng.chance(0.7) ? null : rng.pick(['', 'sc-stale', 'sc-⚠︎']),
      };
    case 'sessionExtract': {
      const startMs = genNumberish(rng, [0, 1500, 12_345.678]);
      return {
        kind,
        bounds: {
          startMs,
          endMs: rng.chance(0.8)
            ? startMs + rng.pick([1, 800, 2500])
            : genNumberish(rng, [0]),
          peakMs: rng.chance(0.3) ? null : startMs + rng.pick([0, 400]),
          confidence: genNumberish(rng, [0, 0.5, 1]),
          detectionModelVersion: rng.pick([
            'session-engine-v1',
            'session-engine-v1/manual-stop-relaxed-1',
            '',
          ]),
        },
        response: genClipResponse(
          rng,
          rng.chance(0.85) ? 'automatic_pose_trigger' : 'imported_video',
        ),
      };
    }
    case 'importPoseExtract': {
      const seedRoll = rng.int(0, 3);
      const seedEdge = rng.pick(SEED_EDGES);
      const seed =
        seedRoll === 0
          ? null
          : seedRoll === 1
            ? undefined
            : { x: seedEdge.x, y: seedEdge.y };
      const seedValid = seed == null ? true : seedEdge.valid;
      let response: Extract<Action, { kind: 'importPoseExtract' }>['response'];
      const roll = rng.int(0, 5);
      if (roll <= 1) {
        response = {
          kind: 'receipt',
          receipt: legalPoseExtraction(rng),
          applied: [],
          expectInvalid: false,
        };
      } else if (roll <= 4) {
        const receipt = legalPoseExtraction(rng);
        const applied: string[] = [];
        let expectInvalid = false;
        // Distinct mutations, legal ones first: a relative invalid edit applied
        // twice, or a legal edit after an invalid one on the same field, would
        // misstate the expected verdict.
        const chosen = new Map<
          string,
          (typeof POSE_EXTRACTION_MUTATIONS)[number]
        >();
        for (let i = 0, n = rng.int(1, 2); i < n; i++) {
          const m = rng.pick(POSE_EXTRACTION_MUTATIONS);
          chosen.set(m.id, m);
        }
        for (const m of [...chosen.values()].sort(
          (a, b) => Number(a.invalid) - Number(b.invalid),
        )) {
          if (m.apply(receipt)) {
            applied.push(m.id);
            if (m.invalid) expectInvalid = true;
          }
        }
        response = { kind: 'receipt', receipt, applied, expectInvalid };
      } else {
        response = { kind: 'reject', ...rng.pick(NATIVE_ERRORS) };
      }
      return { kind, seed, seedValid, response };
    }
    case 'setStrategy': {
      const strategy = rng.pick(['fixed', 'adaptive'] as const);
      const roll = rng.int(0, 5);
      if (roll <= 2)
        return {
          kind,
          strategy,
          applied: rng.chance(0.8)
            ? strategy
            : strategy === 'fixed'
              ? 'adaptive'
              : 'fixed',
          reject: false,
        };
      if (roll === 5)
        return { kind, strategy, applied: undefined, reject: true };
      return {
        kind,
        strategy,
        applied: rng.pick(['FIXED', '', null, 7, 'hybrid', undefined]),
        reject: false,
      };
    }
    case 'toggleMethod':
      return {
        kind,
        method: rng.pick(BRIDGE_METHODS),
        present: rng.chance(0.5),
      };
    case 'benchNew':
      return {
        kind,
        init: {
          startedAtIso:
            state.benchClean || rng.chance(0.9)
              ? new Date(Date.UTC(2026, 0, 1) + rng.int(0, 1e9)).toISOString()
              : '',
          deviceModel:
            state.benchClean || rng.chance(0.95)
              ? rng.pick(['iPhone17,1', 'iPhone15,2', 'iPhone12,8'])
              : '',
          osVersion:
            state.benchClean || rng.chance(0.95)
              ? `${rng.int(17, 19)}.${rng.int(0, 6)}`
              : '',
          appVersion:
            state.benchClean || rng.chance(0.95)
              ? `1.${rng.int(0, 9)}.${rng.int(0, 9)}`
              : '',
        },
      };
    case 'benchPushThermal':
    case 'benchPushFps':
    case 'benchPushMemory': {
      let tMs: number;
      const tRoll = state.benchClean ? 0 : rng.int(0, 9);
      if (tRoll <= 6) {
        state.benchT += rng.pick(BENCH_T_STEP);
        tMs = state.benchT;
      } else if (tRoll === 7) {
        tMs = Math.max(0, state.benchT - rng.int(1, 500));
      } else {
        tMs = rng.pick(NUMERIC_EDGE);
      }
      const clean = state.benchClean;
      const num = (legal: readonly number[]) =>
        clean ? rng.pick(legal) : genNumberish(rng, legal);
      if (kind === 'benchPushThermal') {
        return {
          kind,
          sample: {
            tMs,
            state: (clean || rng.chance(0.9)
              ? rng.pick(['nominal', 'fair', 'serious', 'critical'])
              : rng.pick(['hot', '', 'NOMINAL'])) as ThermalSampleV1['state'],
          },
        };
      }
      if (kind === 'benchPushFps') {
        return {
          kind,
          sample: {
            tMs,
            fps: num([0, 0.5, 14.99, 29.97, 59.94, 120, 240]),
            windowMs:
              clean || rng.chance(0.85)
                ? rng.pick([1, 500, 1000, 2000])
                : rng.pick([0, -5, Number.NaN, Number.POSITIVE_INFINITY]),
          },
        };
      }
      return {
        kind,
        sample: {
          tMs,
          footprintBytes: num([0, 1, 250_000_000, 2 ** 31, 2 ** 40]),
        },
      };
    }
    case 'benchCapture': {
      const clean = state.benchClean;
      return {
        kind,
        capture: {
          clipUri:
            clean || rng.chance(0.9)
              ? `file:///tmp/clip-${rng.hex(6)}.mov`
              : '',
          finalizedAtMs:
            clean || rng.chance(0.85)
              ? (state.benchT += rng.pick(BENCH_T_STEP))
              : rng.pick(NUMERIC_EDGE),
          completionStrategy: (clean || rng.chance(0.9)
            ? rng.pick(['fixed', 'adaptive'])
            : rng.pick([
                'hybrid',
                '',
              ])) as DeviceBenchCaptureRefV1['completionStrategy'],
          telemetrySchemas:
            clean || rng.chance(0.9)
              ? rng.pick([
                  [],
                  ['capture-completion.v1'],
                  ['capture-completion.v1', 'target-lock.v1'],
                ])
              : rng.pick([
                  [''],
                  ['ok', ''],
                  'capture-completion.v1' as unknown as string[],
                ]),
        },
      };
    }
    case 'benchNote':
      return {
        kind,
        note: rng.pick([
          '',
          'thermal throttled',
          'bench note ✓',
          'a'.repeat(rng.int(1, 300)),
        ]),
      };
    case 'benchFinalize':
      return {
        kind,
        reasons: state.benchClean
          ? {
              thermal: 'no_thermal_api',
              fps: 'no_display_link',
              memory: 'no_footprint_api',
            }
          : {
              ...(rng.chance(0.7)
                ? { thermal: rng.pick(['no_thermal_api', '']) }
                : {}),
              ...(rng.chance(0.7)
                ? { fps: rng.pick(['no_display_link', '']) }
                : {}),
              ...(rng.chance(0.7)
                ? { memory: rng.pick(['no_footprint_api', '']) }
                : {}),
            },
      };
    case 'benchValidate':
      return { kind, mutation: rng.pick(BENCH_DOC_MUTATION_IDS) };
    case 'benchFilename':
      return {
        kind,
        iso: new Date(
          Date.UTC(2020, 0, 1) + rng.int(0, 2 ** 31) * 100,
        ).toISOString(),
      };
  }
}

export function generateActions(seed: number): Action[] {
  const rng = createSeededRng(seed);
  const length = rng.int(MIN_SEQUENCE_LENGTH, MAX_SEQUENCE_LENGTH);
  const state: GenState = {
    liveSubscribers: 0,
    benchT: 0,
    benchClean: rng.chance(0.5),
  };
  const actions: Action[] = [];
  for (let i = 0; i < length; i++) actions.push(generateAction(rng, state));
  return actions;
}

// ─── Bench document mutations for validateDeviceBenchExport ─────────────────

const BENCH_DOC_MUTATIONS: Record<
  string,
  { expect: string[]; apply(doc: Payload): void }
> = {
  none: { expect: [], apply: () => undefined },
  schema_2: {
    expect: ['schemaVersion'],
    apply: d => {
      d.schemaVersion = 2;
    },
  },
  schema_string: {
    expect: ['schemaVersion'],
    apply: d => {
      d.schemaVersion = '1';
    },
  },
  startedAt_empty: {
    expect: ['startedAtIso'],
    apply: d => {
      d.startedAtIso = '';
    },
  },
  deviceModel_number: {
    expect: ['deviceModel'],
    apply: d => {
      d.deviceModel = 17;
    },
  },
  duration_negative: {
    expect: ['durationMs'],
    apply: d => {
      d.durationMs = -1;
    },
  },
  duration_nan: {
    expect: ['durationMs'],
    apply: d => {
      d.durationMs = Number.NaN;
    },
  },
  thermal_missing: {
    expect: ['thermal'],
    apply: d => {
      delete d.thermal;
    },
  },
  thermal_samples_object: {
    expect: ['thermal.samples'],
    apply: d => {
      (d.thermal as Payload).samples = {};
    },
  },
  thermal_empty_no_reason: {
    expect: ['thermal'],
    apply: d => {
      (d.thermal as Payload).samples = [];
      (d.thermal as Payload).unavailableReason = null;
    },
  },
  thermal_empty_blank_reason: {
    expect: ['thermal'],
    apply: d => {
      (d.thermal as Payload).samples = [];
      (d.thermal as Payload).unavailableReason = '';
    },
  },
  thermal_populated_with_reason: {
    expect: ['thermal'],
    apply: d => {
      (d.thermal as Payload).samples = [{ tMs: 0, state: 'nominal' }];
      (d.thermal as Payload).unavailableReason = 'stale';
    },
  },
  thermal_state_invalid: {
    expect: ['thermal.samples[0].state'],
    apply: d => {
      (d.thermal as Payload).samples = [{ tMs: 0, state: 'hot' }];
      (d.thermal as Payload).unavailableReason = null;
    },
  },
  thermal_time_backwards: {
    expect: ['thermal.samples[1].tMs'],
    apply: d => {
      (d.thermal as Payload).samples = [
        { tMs: 10, state: 'nominal' },
        { tMs: 9, state: 'fair' },
      ];
      (d.thermal as Payload).unavailableReason = null;
    },
  },
  fps_negative: {
    expect: ['fps.samples[0].fps'],
    apply: d => {
      (d.fps as Payload).samples = [{ tMs: 0, fps: -1, windowMs: 1000 }];
      (d.fps as Payload).unavailableReason = null;
    },
  },
  fps_window_zero: {
    expect: ['fps.samples[0].windowMs'],
    apply: d => {
      (d.fps as Payload).samples = [{ tMs: 0, fps: 30, windowMs: 0 }];
      (d.fps as Payload).unavailableReason = null;
    },
  },
  fps_tMs_nan: {
    expect: ['fps.samples[0].tMs'],
    apply: d => {
      (d.fps as Payload).samples = [
        { tMs: Number.NaN, fps: 30, windowMs: 1000 },
      ];
      (d.fps as Payload).unavailableReason = null;
    },
  },
  fps_sample_null: {
    expect: ['fps.samples[0]'],
    apply: d => {
      (d.fps as Payload).samples = [null];
      (d.fps as Payload).unavailableReason = null;
    },
  },
  memory_negative: {
    expect: ['memory.samples[0].footprintBytes'],
    apply: d => {
      (d.memory as Payload).samples = [{ tMs: 0, footprintBytes: -1 }];
      (d.memory as Payload).unavailableReason = null;
    },
  },
  memory_reason_number: {
    expect: ['memory'],
    apply: d => {
      (d.memory as Payload).samples = [];
      (d.memory as Payload).unavailableReason = 5;
    },
  },
  captures_not_array: {
    expect: ['captures'],
    apply: d => {
      d.captures = {};
    },
  },
  capture_clipUri_empty: {
    expect: ['captures[0].clipUri'],
    apply: d => {
      d.captures = [
        {
          clipUri: '',
          finalizedAtMs: 1,
          completionStrategy: 'fixed',
          telemetrySchemas: [],
        },
      ];
    },
  },
  capture_strategy_unknown: {
    expect: ['captures[0].completionStrategy'],
    apply: d => {
      d.captures = [
        {
          clipUri: 'file:///c.mov',
          finalizedAtMs: 1,
          completionStrategy: 'hybrid',
          telemetrySchemas: [],
        },
      ];
    },
  },
  capture_schemas_blank: {
    expect: ['captures[0].telemetrySchemas'],
    apply: d => {
      d.captures = [
        {
          clipUri: 'file:///c.mov',
          finalizedAtMs: 1,
          completionStrategy: 'fixed',
          telemetrySchemas: [''],
        },
      ];
    },
  },
  capture_finalized_negative: {
    expect: ['captures[0].finalizedAtMs'],
    apply: d => {
      d.captures = [
        {
          clipUri: 'file:///c.mov',
          finalizedAtMs: -1,
          completionStrategy: 'fixed',
          telemetrySchemas: [],
        },
      ];
    },
  },
  notes_with_number: {
    expect: ['notes'],
    apply: d => {
      d.notes = ['ok', 3];
    },
  },
  notes_string: {
    expect: ['notes'],
    apply: d => {
      d.notes = 'ok';
    },
  },
  two_problems: {
    expect: ['durationMs', 'notes'],
    apply: d => {
      d.durationMs = Number.POSITIVE_INFINITY;
      d.notes = null;
    },
  },
};
const BENCH_DOC_MUTATION_IDS = Object.keys(BENCH_DOC_MUTATIONS);

function validBenchDocument(): Payload {
  return {
    schemaVersion: DEVICE_BENCH_SCHEMA_VERSION,
    startedAtIso: '2026-01-01T00:00:00.000Z',
    durationMs: 1234,
    deviceModel: 'iPhone17,1',
    osVersion: '18.4',
    appVersion: '1.0.0',
    thermal: {
      samples: [
        { tMs: 0, state: 'nominal' },
        { tMs: 1000, state: 'fair' },
      ],
      unavailableReason: null,
    },
    fps: { samples: [], unavailableReason: 'display_link_unavailable' },
    memory: {
      samples: [
        { tMs: 0, footprintBytes: 1 },
        { tMs: 0, footprintBytes: 2 },
      ],
      unavailableReason: null,
    },
    captures: [
      {
        clipUri: 'file:///tmp/c.mov',
        finalizedAtMs: 1234,
        completionStrategy: 'adaptive',
        telemetrySchemas: ['capture-completion.v1'],
      },
    ],
    notes: ['synthetic fixture'],
  };
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface HarnessEnv {
  sim: SimulatedBridge;
  stability: StabilityRecorder;
}

export interface StepTrace {
  i: number;
  kind: ActionKind;
  params: string;
  outcome: string;
}

export interface InvariantFailure {
  invariant: string;
  step: number;
  kind: ActionKind;
  detail: string;
  params: string;
}

export interface SequenceStats {
  steps: number;
  byKind: Record<string, number>;
  clipsAccepted: number;
  clipsRejected: number;
  nativeCalls: number;
  eventsDelivered: number;
  benchFinalizeOk: number;
  benchFinalizeThrew: number;
}

export interface SequenceResult {
  seed: number;
  length: number;
  ok: boolean;
  failures: InvariantFailure[];
  trace: StepTrace[];
  stats: SequenceStats;
}

interface Subscriber {
  id: number;
  unsubscribe: () => void;
  received: object[];
  live: boolean;
}

interface Model {
  buffer: AttemptEvidenceBuffer;
  readiness: ReadinessSnapshot | null;
  quality: CaptureQualitySignalsV1 | null;
  lastEnvelope: EnvelopeVerdict | null;
  subscribers: Subscriber[];
  nextSubscriberId: number;
  screenReceived: number;
  sessionId: string | null;
  bench: BenchModel;
  recorder: DeviceBenchRecorder;
  guidanceText: Map<string, string>;
  present: Set<BridgeMethodName>;
}

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    readonly detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

function must(
  condition: boolean,
  invariant: string,
  detail: () => string,
): void {
  if (!condition) throw new InvariantViolation(invariant, detail());
}

const INVALID_CLIP_MESSAGE =
  'The native camera returned an invalid or incomplete video result.';
const INVALID_POSE_MESSAGE =
  'The native importer returned an invalid pose-extraction result.';
const INVALID_RECEIPT_MESSAGE =
  'The native camera returned an invalid session receipt.';
const SEED_MESSAGE =
  'The target seed must be a normalized point inside the video frame.';
const UNAVAILABLE_MESSAGES: Record<BridgeMethodName, string> = {
  capture: 'Real guided camera capture is not available on this device.',
  importVideo: 'Real video import is not available on this device.',
  cancel: '',
  readTextFile: '',
  setCompletionStrategy:
    'Completion strategy switching is not available in this build.',
  startSessionCapture:
    'Native session capture is not available on this device.',
  stopSessionCapture: 'Native session capture is not available on this device.',
  extractSessionEventClip:
    'Native session clip extraction is not available on this device.',
  extractImportedPoseSequence:
    'Imported-video pose extraction is not available in this build.',
};

async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nativeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function freshBench(init: DeviceBenchRecorderInit): {
  model: BenchModel;
  recorder: DeviceBenchRecorder;
} {
  return {
    model: {
      init: { ...init },
      thermal: [],
      fps: [],
      memory: [],
      captures: [],
      notes: [],
      lastTMs: 0,
    },
    recorder: new DeviceBenchRecorder(init),
  };
}

function scriptResponse(
  env: HarnessEnv,
  method: BridgeMethodName,
  response: ScriptedResponse,
): void {
  env.sim.script.impl[method] = () => {
    if (response.kind === 'reject')
      return Promise.reject(nativeError(response.code, response.message));
    return Promise.resolve(
      response.kind === 'payload' ? response.payload : response.value,
    );
  };
}

function checkClipOutcome(
  result: Awaited<ReturnType<typeof settle<CapturedClip>>>,
  response: ScriptedResponse,
  entryMode: ClipMode | null,
  scripted: Error | null,
): string {
  if (response.kind === 'reject') {
    must(!result.ok, 'I-ERR', () => 'native rejection was swallowed');
    must(
      result.ok === false && result.error === scripted,
      'I-ERR',
      () =>
        `rejection not propagated verbatim: ${short(result.ok ? null : errorMessage(result.error))}`,
    );
    return `rejected:${response.code}`;
  }
  if (response.kind === 'junk') {
    must(!result.ok, 'I-CLIP', () => `junk ${short(response.value)} accepted`);
    must(
      result.ok === false &&
        errorMessage(result.error) === INVALID_CLIP_MESSAGE,
      'I-CLIP',
      () =>
        `junk error was ${short(result.ok ? null : errorMessage(result.error))}`,
    );
    return 'invalid:junk';
  }
  const modeMismatch = entryMode !== null && response.mode !== entryMode;
  if (response.expectInvalid || modeMismatch) {
    const inv = modeMismatch && !response.expectInvalid ? 'I-MODE' : 'I-CLIP';
    must(
      !result.ok,
      inv,
      () =>
        `payload accepted despite ${modeMismatch ? `mode ${response.mode}≠${entryMode}` : `mutations ${response.applied.join(',')}`}`,
    );
    must(
      result.ok === false &&
        errorMessage(result.error) === INVALID_CLIP_MESSAGE,
      inv,
      () =>
        `wrong error: ${short(result.ok ? null : errorMessage(result.error))}`,
    );
    return modeMismatch
      ? 'invalid:mode'
      : `invalid:${response.applied.join(',')}`;
  }
  must(
    result.ok,
    'I-CLIP',
    () =>
      `legal payload rejected (${response.applied.join(',') || 'unmutated'}): ${short(result.ok ? null : errorMessage(result.error))}`,
  );
  must(
    result.ok && (result.value as unknown) === (response.payload as unknown),
    'I-CLIP',
    () => 'accepted clip is not the same object (repaired/copied)',
  );
  return `accepted:${response.applied.join(',') || 'legal'}`;
}

export async function runActions(
  actions: Action[],
  env: HarnessEnv,
  seed: number,
): Promise<SequenceResult> {
  const { sim, stability } = env;
  // Reset the world.
  sim.script.impl = {};
  sim.script.calls.length = 0;
  sim.listeners.length = 0;
  for (const name of BRIDGE_METHODS) sim.bridge[name] = sim.originals[name];
  stability.reset();

  const bench = freshBench({
    startedAtIso: '2026-01-01T00:00:00.000Z',
    deviceModel: 'iPhone17,1',
    osVersion: '18.0',
    appVersion: '1.0.0',
  });
  const model: Model = {
    buffer: createAttemptEvidenceBuffer(),
    readiness: null,
    quality: null,
    lastEnvelope: null,
    subscribers: [],
    nextSubscriberId: 1,
    screenReceived: 0,
    sessionId: null,
    bench: bench.model,
    recorder: bench.recorder,
    guidanceText: new Map(),
    present: new Set(BRIDGE_METHODS),
  };
  // Permanent "screen" subscriber mirroring AnalyzeScreen's evidence wiring.
  const screen = subscribeToCameraEvents(event => {
    model.screenReceived += 1;
    if (event.type === 'readiness') {
      const snapshot = {
        state: event.state,
        jointCoverage: event.jointCoverage,
      };
      model.buffer.noteReadiness(snapshot);
      model.readiness = snapshot;
    } else if (event.type === 'capture_quality') {
      model.buffer.noteQuality(event.signals);
      model.quality = event.signals;
    }
  });

  const stats: SequenceStats = {
    steps: 0,
    byKind: {},
    clipsAccepted: 0,
    clipsRejected: 0,
    nativeCalls: 0,
    eventsDelivered: 0,
    benchFinalizeOk: 0,
    benchFinalizeThrew: 0,
  };
  const trace: StepTrace[] = [];
  const failures: InvariantFailure[] = [];

  const has = (name: BridgeMethodName) => model.present.has(name);
  let callsBefore = 0;
  const callsOf = (name: BridgeMethodName) =>
    sim.script.calls.slice(callsBefore).filter(c => c.method === name);

  const checkGlobal = (): void => {
    must(
      cameraAvailable() === has('capture'),
      'I-AV',
      () =>
        `cameraAvailable=${cameraAvailable()} capture present=${has('capture')}`,
    );
    must(
      sessionCaptureAvailable() ===
        (has('startSessionCapture') &&
          has('stopSessionCapture') &&
          has('extractSessionEventClip')),
      'I-AV',
      () =>
        `sessionCaptureAvailable=${sessionCaptureAvailable()} present=${[...model.present].join(',')}`,
    );
    must(
      videoImportAvailable() === has('importVideo'),
      'I-AV',
      () => `videoImportAvailable=${videoImportAvailable()}`,
    );
    must(
      importedPoseExtractionAvailable() === has('extractImportedPoseSequence'),
      'I-AV',
      () =>
        `importedPoseExtractionAvailable=${importedPoseExtractionAvailable()}`,
    );
    must(
      model.buffer.readiness === model.readiness,
      'I-BUF',
      () =>
        `buffer.readiness ${short(model.buffer.readiness)} ≠ model ${short(model.readiness)}`,
    );
    must(
      model.buffer.quality === model.quality,
      'I-BUF',
      () =>
        `buffer.quality ${short(model.buffer.quality)} ≠ model ${short(model.quality)}`,
    );
    const live = liveCaptureEnvelope(
      model.buffer.readiness,
      model.buffer.quality,
    );
    if (!model.readiness && !model.quality) {
      must(
        live === null,
        'I-ENV',
        () => `live envelope fabricated from silence: ${short(live)}`,
      );
    } else {
      must(live !== null, 'I-ENV', () => 'live envelope null despite evidence');
      const expected = oracleVerdict({
        ...qualityInputs(model.quality),
        player_visibility: visibilityOf(model.readiness),
      });
      must(
        live !== null && deepEqual(projectVerdict(live), expected),
        'I-ENV',
        () =>
          `live verdict ${short(live && projectVerdict(live), 600)} ≠ oracle ${short(expected, 600)}`,
      );
    }
  };

  const checkVerdictShape = (verdict: EnvelopeVerdict): void => {
    must(
      typeof verdict.thresholdsVersion === 'string' &&
        verdict.thresholdsVersion.length > 0,
      'I-ENV',
      () => 'thresholdsVersion missing',
    );
    must(
      typeof verdict.provisional === 'boolean',
      'I-ENV',
      () => 'provisional not boolean',
    );
    must(
      verdict.dimensions.every(
        d =>
          typeof d.unit === 'string' &&
          d.unit.length > 0 &&
          typeof d.thresholdId === 'string' &&
          d.thresholdId.length > 0,
      ),
      'I-ENV',
      () => 'dimension unit/thresholdId missing',
    );
  };

  const checkGuidance = (envelope: EnvelopeVerdict | null): string => {
    const lines = captureGuidanceLines(envelope);
    const expected = envelope
      ? ORACLE_DIMENSIONS.filter(dim => {
          const status = envelope.dimensions.find(
            d => d.dimension === dim,
          )?.status;
          return status === 'DEGRADED' || status === 'UNSUPPORTED';
        })
      : [];
    must(
      deepEqual(
        lines.map(l => l.dimension),
        expected,
      ),
      'I-GUIDE',
      () =>
        `guidance dims ${short(lines.map(l => l.dimension))} ≠ ${short(expected)}`,
    );
    for (const line of lines) {
      const status = envelope?.dimensions.find(
        d => d.dimension === line.dimension,
      )?.status;
      must(
        line.status === status,
        'I-GUIDE',
        () => `line status ${line.status} ≠ verdict ${status}`,
      );
      must(
        typeof line.text === 'string' && line.text.trim().length > 0,
        'I-GUIDE',
        () => `empty guidance for ${line.dimension}`,
      );
      const lower = line.text.toLowerCase();
      const hit = POLICY_FORBIDDEN.find(word => lower.includes(word));
      must(
        hit === undefined,
        'I-GUIDE',
        () => `policy-forbidden term "${hit}" in guidance: ${line.text}`,
      );
      const key = `${line.dimension}:${line.status}`;
      const prior = model.guidanceText.get(key);
      must(
        prior === undefined || prior === line.text,
        'I-GUIDE',
        () => `guidance text drifted for ${key}`,
      );
      model.guidanceText.set(key, line.text);
    }
    return `${lines.length}`;
  };

  const emit = (event: object): void => {
    for (const listener of [...sim.listeners]) listener(event);
  };

  const step = async (action: Action, i: number): Promise<string> => {
    callsBefore = sim.script.calls.length;
    const stabilityBefore = stability.events().length;
    let outcome = '';
    switch (action.kind) {
      case 'subscribe': {
        const subscriber: Subscriber = {
          id: model.nextSubscriberId++,
          received: [],
          live: true,
          unsubscribe: () => undefined,
        };
        subscriber.unsubscribe = subscribeToCameraEvents(event =>
          subscriber.received.push(event),
        );
        model.subscribers.push(subscriber);
        must(
          typeof subscriber.unsubscribe === 'function',
          'I-EVT',
          () => 'subscribe did not return a function',
        );
        outcome = `sub#${subscriber.id}`;
        break;
      }
      case 'unsubscribe': {
        const live = model.subscribers.filter(s => s.live);
        if (live.length === 0) {
          outcome = 'noop';
          break;
        }
        const target = live[action.slot % live.length] as Subscriber;
        target.unsubscribe();
        target.live = false;
        if (action.twice) target.unsubscribe();
        outcome = `unsub#${target.id}${action.twice ? 'x2' : ''}`;
        break;
      }
      case 'emit': {
        const before = model.subscribers.map(s => s.received.length);
        const screenBefore = model.screenReceived;
        const event = action.event;
        emit(event);
        model.subscribers.forEach((s, idx) => {
          const delta = s.received.length - (before[idx] as number);
          must(
            delta === (s.live ? 1 : 0),
            'I-EVT',
            () => `subscriber#${s.id} live=${s.live} received ${delta} copies`,
          );
          if (s.live) {
            must(
              s.received[s.received.length - 1] === event,
              'I-EVT',
              () => `subscriber#${s.id} got a different object`,
            );
            stats.eventsDelivered += 1;
          }
        });
        must(
          model.screenReceived === screenBefore + 1,
          'I-EVT',
          () => 'screen subscriber missed the event',
        );
        outcome = `emit:${String(event.type)}`;
        break;
      }
      case 'beginAttempt':
        model.buffer.beginAttempt();
        model.readiness = null;
        model.quality = null;
        must(
          model.buffer.readiness === null && model.buffer.quality === null,
          'I-BUF',
          () => 'beginAttempt left evidence',
        );
        must(
          liveCaptureEnvelope(model.buffer.readiness, model.buffer.quality) ===
            null,
          'I-ENV',
          () => 'envelope after beginAttempt not null',
        );
        outcome = 'cleared';
        break;
      case 'evaluateLive': {
        const readinessSnap = stableJson(model.buffer.readiness);
        const qualitySnap = stableJson(model.buffer.quality);
        const verdict = liveCaptureEnvelope(
          model.buffer.readiness,
          model.buffer.quality,
        );
        const again = liveCaptureEnvelope(
          model.buffer.readiness,
          model.buffer.quality,
        );
        must(
          deepEqual(verdict, again),
          'I-PURE',
          () => 'liveCaptureEnvelope not deterministic for identical inputs',
        );
        must(
          stableJson(model.buffer.readiness) === readinessSnap &&
            stableJson(model.buffer.quality) === qualitySnap,
          'I-PURE',
          () => 'liveCaptureEnvelope mutated its inputs',
        );
        if (verdict) checkVerdictShape(verdict);
        model.lastEnvelope = verdict;
        outcome = verdict
          ? `${verdict.overallWithCoverage}/nm=${verdict.notMeasured.length}`
          : 'null';
        break;
      }
      case 'evaluateAttempt': {
        const clipSnap = stableJson(action.clip);
        const verdict = attemptCaptureEnvelope(
          action.clip,
          model.buffer.quality,
          model.buffer.readiness,
        );
        must(
          stableJson(action.clip) === clipSnap,
          'I-PURE',
          () => 'attemptCaptureEnvelope mutated the clip',
        );
        const expected = oracleVerdict({
          ...qualityInputs(model.quality),
          resolution: resolutionOf(action.clip.width, action.clip.height),
          frame_rate: action.clip.fps,
          clip_duration: action.clip.durationMs,
          player_visibility: visibilityOf(model.readiness),
        });
        must(
          deepEqual(projectVerdict(verdict), expected),
          'I-ENV',
          () =>
            `attempt verdict ${short(projectVerdict(verdict), 600)} ≠ oracle ${short(expected, 600)}`,
        );
        checkVerdictShape(verdict);
        model.lastEnvelope = verdict;
        outcome = verdict.overallWithCoverage;
        break;
      }
      case 'evaluateSessionClip': {
        const verdict = sessionEventClipEnvelope(action.clip);
        const expected = oracleVerdict({
          resolution: resolutionOf(action.clip.width, action.clip.height),
          frame_rate: action.clip.fps,
        });
        must(
          deepEqual(projectVerdict(verdict), expected),
          'I-ENV',
          () =>
            `session verdict ${short(projectVerdict(verdict), 600)} ≠ oracle ${short(expected, 600)}`,
        );
        const duration = verdict.dimensions.find(
          d => d.dimension === 'clip_duration',
        );
        must(
          duration?.status === 'NOT_MEASURED' && duration.measured === null,
          'I-SESSENV',
          () => `clip_duration judged: ${short(duration)}`,
        );
        checkVerdictShape(verdict);
        model.lastEnvelope = verdict;
        outcome = verdict.overallWithCoverage;
        break;
      }
      case 'guidance': {
        const snap = stableJson(model.lastEnvelope);
        const lines = checkGuidance(model.lastEnvelope);
        must(
          stableJson(model.lastEnvelope) === snap,
          'I-PURE',
          () => 'captureGuidanceLines mutated the verdict',
        );
        must(
          captureGuidanceLines(null).length === 0,
          'I-GUIDE',
          () => 'guidance invented for null envelope',
        );
        outcome = `lines=${lines}`;
        break;
      }
      case 'blockedMessage': {
        const lines = captureGuidanceLines(model.lastEnvelope);
        const message = qualityBlockedMessage(
          action.reason,
          model.lastEnvelope,
        );
        if (lines.length === 0) {
          must(
            message === action.reason,
            'I-BLOCK',
            () => `message ${short(message)} ≠ reason`,
          );
        } else {
          const expected = `${action.reason}\n\n${lines.map(l => `• ${l.text}`).join('\n')}`;
          must(
            message === expected,
            'I-BLOCK',
            () => `message ${short(message, 400)} ≠ ${short(expected, 400)}`,
          );
        }
        must(
          qualityBlockedMessage(action.reason, null) === action.reason,
          'I-BLOCK',
          () => 'null envelope altered the reason',
        );
        outcome = `lines=${lines.length}`;
        break;
      }
      case 'readyGate': {
        const gate = readyGate(model.lastEnvelope);
        const expected = model.lastEnvelope
          ? model.lastEnvelope.dimensions
              .filter(d => d.status === 'UNSUPPORTED')
              .map(d => d.dimension)
          : [];
        must(
          deepEqual(gate.blockingDimensions, expected),
          'I-GATE',
          () =>
            `blocking ${short(gate.blockingDimensions)} ≠ ${short(expected)}`,
        );
        must(
          gate.blocked === expected.length > 0,
          'I-GATE',
          () => `blocked=${gate.blocked} with ${expected.length} UNSUPPORTED`,
        );
        const degradedOnly =
          model.lastEnvelope?.dimensions.some(d => d.status === 'DEGRADED') &&
          expected.length === 0;
        if (degradedOnly)
          must(!gate.blocked, 'I-GATE', () => 'DEGRADED blocked Ready');
        must(
          deepEqual(readyGate(null), {
            blocked: false,
            blockingDimensions: [],
          }),
          'I-GATE',
          () => 'null envelope blocked',
        );
        outcome = gate.blocked ? `blocked:${expected.join(',')}` : 'open';
        break;
      }
      case 'nativeCapture':
      case 'nativeImport': {
        const method: BridgeMethodName =
          action.kind === 'nativeCapture' ? 'capture' : 'importVideo';
        const entryMode: ClipMode =
          action.kind === 'nativeCapture'
            ? 'automatic_pose_trigger'
            : 'imported_video';
        const op =
          action.kind === 'nativeCapture'
            ? captureStrokeVideo
            : importStrokeVideo;
        if (!has(method)) {
          const result = await settle(op());
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                UNAVAILABLE_MESSAGES[method],
            'I-UNAV',
            () => `missing ${method}: ${short(result)}`,
          );
          must(
            sim.script.calls.length === callsBefore,
            'I-UNAV',
            () => 'native call made while unavailable',
          );
          outcome = 'unavailable';
          break;
        }
        let scripted: Error | null = null;
        if (action.response.kind === 'reject') {
          scripted = nativeError(action.response.code, action.response.message);
          const error = scripted;
          sim.script.impl[method] = () => Promise.reject(error);
        } else {
          scriptResponse(env, method, action.response);
        }
        const payloadSnap =
          action.response.kind === 'payload'
            ? stableJson(action.response.payload)
            : null;
        const result = await settle(op());
        must(
          callsOf(method).length === 1 &&
            sim.script.calls.length === callsBefore + 1,
          'I-REQ',
          () => `${method} called ${callsOf(method).length} times`,
        );
        must(
          (callsOf(method)[0]?.args.length ?? -1) === 0,
          'I-REQ',
          () =>
            `${method} called with arguments ${short(callsOf(method)[0]?.args)}`,
        );
        outcome = checkClipOutcome(
          result,
          action.response,
          entryMode,
          scripted,
        );
        if (payloadSnap !== null) {
          must(
            stableJson((action.response as { payload: Payload }).payload) ===
              payloadSnap,
            'I-CLIP',
            () => 'boundary mutated the native payload',
          );
        }
        if (result.ok) stats.clipsAccepted += 1;
        else stats.clipsRejected += 1;
        break;
      }
      case 'assertClip': {
        const value =
          action.response.kind === 'payload'
            ? action.response.payload
            : action.response.value;
        const snap = stableJson(value);
        let result: Awaited<ReturnType<typeof settle<CapturedClip>>>;
        try {
          result = {
            ok: true,
            value: assertCapturedClip(value, action.expectedMode ?? undefined),
          };
        } catch (error) {
          result = { ok: false, error };
        }
        outcome = checkClipOutcome(
          result,
          action.response,
          action.expectedMode,
          null,
        );
        must(
          stableJson(value) === snap,
          'I-CLIP',
          () => 'assertCapturedClip mutated its input',
        );
        if (result.ok) stats.clipsAccepted += 1;
        else stats.clipsRejected += 1;
        break;
      }
      case 'sessionStart': {
        const result = has('startSessionCapture')
          ? await (async () => {
              let scripted: Error | null = null;
              if (action.reject) {
                scripted = nativeError(
                  'camera.session_start_failed',
                  'Session start failed',
                );
                const error = scripted;
                sim.script.impl.startSessionCapture = () =>
                  Promise.reject(error);
              } else {
                const receipt = action.receipt;
                sim.script.impl.startSessionCapture = () =>
                  Promise.resolve(receipt);
              }
              return { ...(await settle(startSessionCapture())), scripted };
            })()
          : { ...(await settle(startSessionCapture())), scripted: null };
        const events = stability.events().slice(stabilityBefore);
        must(
          events.length === 1,
          'I-SESS',
          () => `${events.length} stability events recorded`,
        );
        const event = events[0];
        if (!has('startSessionCapture')) {
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                UNAVAILABLE_MESSAGES.startSessionCapture,
            'I-UNAV',
            () => short(result),
          );
          must(
            event?.kind === 'camera_startup_failed' &&
              event.reason === 'session_capture_unavailable',
            'I-SESS',
            () => `event ${short(event)}`,
          );
          must(
            sim.script.calls.length === callsBefore,
            'I-UNAV',
            () => 'native call made while unavailable',
          );
          outcome = 'unavailable';
          break;
        }
        must(
          callsOf('startSessionCapture').length === 1,
          'I-REQ',
          () => 'startSessionCapture native call count ≠ 1',
        );
        if (action.reject) {
          must(
            !result.ok && result.error === result.scripted,
            'I-ERR',
            () => 'native session error not propagated verbatim',
          );
          must(
            event?.kind === 'camera_startup_failed' &&
              event.reason === 'native_session_start_error',
            'I-SESS',
            () => `event ${short(event)}`,
          );
          outcome = 'native_error';
        } else if (action.valid) {
          const id = (action.receipt as Payload).sessionCaptureId;
          must(
            result.ok,
            'I-SESS',
            () =>
              `valid receipt rejected: ${short(result.ok ? null : errorMessage(result.error))}`,
          );
          must(
            result.ok && deepEqual(result.value, { sessionCaptureId: id }),
            'I-SESS',
            () =>
              `receipt ${short(result.ok ? result.value : null)} ≠ {sessionCaptureId}`,
          );
          must(
            event?.kind === 'camera_startup_succeeded',
            'I-SESS',
            () => `event ${short(event)}`,
          );
          model.sessionId = id as string;
          outcome = 'started';
        } else {
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                INVALID_RECEIPT_MESSAGE,
            'I-SESS',
            () => `invalid receipt ${short(action.receipt)} → ${short(result)}`,
          );
          must(
            event?.kind === 'camera_startup_failed' &&
              event.reason === 'invalid_session_receipt',
            'I-SESS',
            () => `event ${short(event)}`,
          );
          outcome = 'invalid_receipt';
        }
        break;
      }
      case 'sessionStop': {
        const id = action.id ?? model.sessionId ?? 'sc-none';
        sim.script.impl.stopSessionCapture = () => Promise.resolve(undefined);
        const result = await settle(stopSessionCapture(id));
        if (!has('stopSessionCapture')) {
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                UNAVAILABLE_MESSAGES.stopSessionCapture,
            'I-UNAV',
            () => short(result),
          );
          must(
            sim.script.calls.length === callsBefore,
            'I-UNAV',
            () => 'native call made while unavailable',
          );
          outcome = 'unavailable';
          break;
        }
        must(
          result.ok && result.value === undefined,
          'I-REQ',
          () => `stop failed: ${short(result)}`,
        );
        const calls = callsOf('stopSessionCapture');
        must(
          calls.length === 1 && deepEqual(calls[0]?.args, [id]),
          'I-REQ',
          () => `stop args ${short(calls.map(c => c.args))} ≠ [${id}]`,
        );
        if (action.id === null) model.sessionId = null;
        outcome = 'stopped';
        break;
      }
      case 'sessionExtract': {
        const id = model.sessionId ?? `sc-${seed.toString(16)}`;
        if (!has('extractSessionEventClip')) {
          const result = await settle(
            extractSessionEventClip(id, action.bounds),
          );
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                UNAVAILABLE_MESSAGES.extractSessionEventClip,
            'I-UNAV',
            () => short(result),
          );
          must(
            sim.script.calls.length === callsBefore,
            'I-UNAV',
            () => 'native call made while unavailable',
          );
          outcome = 'unavailable';
          break;
        }
        let scripted: Error | null = null;
        if (action.response.kind === 'reject') {
          scripted = nativeError(action.response.code, action.response.message);
          const error = scripted;
          sim.script.impl.extractSessionEventClip = () => Promise.reject(error);
        } else {
          scriptResponse(env, 'extractSessionEventClip', action.response);
        }
        const boundsSnap = stableJson(action.bounds);
        const result = await settle(extractSessionEventClip(id, action.bounds));
        const calls = callsOf('extractSessionEventClip');
        must(
          calls.length === 1,
          'I-REQ',
          () => `extract called ${calls.length} times`,
        );
        const expectedRequest = {
          sessionCaptureId: id,
          startMs: action.bounds.startMs,
          endMs: action.bounds.endMs,
          peakMs: action.bounds.peakMs,
          confidence: action.bounds.confidence,
          detectionModelVersion: action.bounds.detectionModelVersion,
        };
        must(
          deepEqual(calls[0]?.args, [expectedRequest]),
          'I-REQ',
          () =>
            `request ${short(calls[0]?.args)} ≠ ${short([expectedRequest])}`,
        );
        must(
          stableJson(action.bounds) === boundsSnap,
          'I-PURE',
          () => 'bounds mutated',
        );
        outcome = checkClipOutcome(
          result,
          action.response,
          'automatic_pose_trigger',
          scripted,
        );
        if (result.ok) stats.clipsAccepted += 1;
        else stats.clipsRejected += 1;
        break;
      }
      case 'importPoseExtract': {
        const clip = {
          uri: `file:///tmp/import-${seed.toString(16)}-${i}.mov`,
          captureMode: 'imported_video',
        } as Extract<CapturedClip, { captureMode: 'imported_video' }>;
        if (!has('extractImportedPoseSequence')) {
          const result = await settle(
            extractImportedPoseSequence(clip, action.seed),
          );
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                UNAVAILABLE_MESSAGES.extractImportedPoseSequence,
            'I-UNAV',
            () => short(result),
          );
          must(
            sim.script.calls.length === callsBefore,
            'I-UNAV',
            () => 'native call made while unavailable',
          );
          outcome = 'unavailable';
          break;
        }
        let scripted: Error | null = null;
        const response = action.response;
        if (response.kind === 'reject') {
          scripted = nativeError(response.code, response.message);
          const error = scripted;
          sim.script.impl.extractImportedPoseSequence = () =>
            Promise.reject(error);
        } else {
          sim.script.impl.extractImportedPoseSequence = () =>
            Promise.resolve(response.receipt);
        }
        const receiptSnap =
          response.kind === 'receipt' ? stableJson(response.receipt) : null;
        const result = await settle(
          extractImportedPoseSequence(clip, action.seed),
        );
        const calls = callsOf('extractImportedPoseSequence');
        if (!action.seedValid) {
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) === SEED_MESSAGE,
            'I-REQ',
            () => `bad seed ${short(action.seed)} → ${short(result)}`,
          );
          must(
            calls.length === 0,
            'I-REQ',
            () => 'native pose extraction called with an invalid seed',
          );
          outcome = 'seed_rejected';
          break;
        }
        must(
          calls.length === 1,
          'I-REQ',
          () => `extractImportedPoseSequence called ${calls.length} times`,
        );
        const expectedRequest: Payload = { uri: clip.uri };
        if (action.seed) {
          expectedRequest.seedX = action.seed.x;
          expectedRequest.seedY = action.seed.y;
        }
        must(
          deepEqual(calls[0]?.args, [expectedRequest]),
          'I-REQ',
          () =>
            `request ${short(calls[0]?.args)} ≠ ${short([expectedRequest])}`,
        );
        if (response.kind === 'reject') {
          must(
            !result.ok && result.error === scripted,
            'I-ERR',
            () => 'pose-extraction rejection not verbatim',
          );
          outcome = `rejected:${response.code}`;
          break;
        }
        must(
          stableJson(response.receipt) === receiptSnap,
          'I-POSE',
          () => 'receipt mutated',
        );
        if (response.expectInvalid) {
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                INVALID_POSE_MESSAGE,
            'I-POSE',
            () =>
              `invalid receipt (${response.applied.join(',')}) → ${short(result)}`,
          );
          outcome = `invalid:${response.applied.join(',')}`;
        } else {
          const r = response.receipt;
          const expected: Payload = {
            poseSequence: r.poseSequence,
            framesWithPose: r.framesWithPose,
            framesTotal: r.framesTotal,
          };
          if (r.posterUri !== undefined) expected.posterUri = r.posterUri;
          must(
            result.ok,
            'I-POSE',
            () =>
              `legal receipt (${response.applied.join(',') || 'unmutated'}) rejected: ${short(result.ok ? null : errorMessage(result.error))}`,
          );
          must(
            result.ok && deepEqual(result.value, expected),
            'I-POSE',
            () =>
              `projection ${short(result.ok ? result.value : null)} ≠ ${short(expected)}`,
          );
          must(
            result.ok &&
              Object.keys(result.value).every(k =>
                [
                  'poseSequence',
                  'posterUri',
                  'framesWithPose',
                  'framesTotal',
                ].includes(k),
              ),
            'I-POSE',
            () => 'extra keys leaked',
          );
          outcome = `accepted:${response.applied.join(',') || 'legal'}`;
        }
        break;
      }
      case 'setStrategy': {
        if (!has('setCompletionStrategy')) {
          const result = await settle(
            setCaptureCompletionStrategy(action.strategy),
          );
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error) ===
                UNAVAILABLE_MESSAGES.setCompletionStrategy,
            'I-UNAV',
            () => short(result),
          );
          must(
            sim.script.calls.length === callsBefore,
            'I-UNAV',
            () => 'native call made while unavailable',
          );
          outcome = 'unavailable';
          break;
        }
        let scripted: Error | null = null;
        if (action.reject) {
          scripted = nativeError('camera.strategy_failed', 'Strategy failed');
          const error = scripted;
          sim.script.impl.setCompletionStrategy = () => Promise.reject(error);
        } else {
          const applied = action.applied;
          sim.script.impl.setCompletionStrategy = () =>
            Promise.resolve(applied);
        }
        const result = await settle(
          setCaptureCompletionStrategy(action.strategy),
        );
        const calls = callsOf('setCompletionStrategy');
        must(
          calls.length === 1 && deepEqual(calls[0]?.args, [action.strategy]),
          'I-REQ',
          () => `strategy args ${short(calls.map(c => c.args))}`,
        );
        if (action.reject) {
          must(
            !result.ok && result.error === scripted,
            'I-ERR',
            () => 'strategy rejection not verbatim',
          );
          outcome = 'native_error';
        } else if (
          action.applied === 'fixed' ||
          action.applied === 'adaptive'
        ) {
          must(
            result.ok && result.value === action.applied,
            'I-STRAT',
            () => `applied ${short(result)}`,
          );
          outcome = `applied:${action.applied}`;
        } else {
          must(
            !result.ok &&
              errorMessage(result.ok ? null : result.error).includes(
                'unknown completion strategy',
              ),
            'I-STRAT',
            () =>
              `unknown strategy ${short(action.applied)} → ${short(result)}`,
          );
          outcome = 'unknown_strategy';
        }
        break;
      }
      case 'cancel': {
        sim.script.impl.cancel = () => undefined;
        let threw: unknown = null;
        try {
          cancelCameraOperation();
        } catch (error) {
          threw = error;
        }
        must(
          threw === null,
          'I-CANCEL',
          () => `cancel threw ${short(errorMessage(threw))}`,
        );
        must(
          callsOf('cancel').length === (has('cancel') ? 1 : 0),
          'I-CANCEL',
          () =>
            `cancel called ${callsOf('cancel').length} times, present=${has('cancel')}`,
        );
        outcome = has('cancel') ? 'cancelled' : 'noop';
        break;
      }
      case 'toggleMethod': {
        if (action.present) {
          sim.bridge[action.method] = sim.originals[action.method];
          model.present.add(action.method);
        } else {
          delete sim.bridge[action.method];
          model.present.delete(action.method);
        }
        outcome = `${action.method}=${action.present ? 'present' : 'absent'}`;
        break;
      }
      case 'benchNew': {
        const fresh = freshBench(action.init);
        model.bench = fresh.model;
        model.recorder = fresh.recorder;
        outcome = 'new';
        break;
      }
      case 'benchPushThermal':
        model.recorder.pushThermal(action.sample);
        model.bench.thermal.push({ ...action.sample });
        observeT(model.bench, action.sample.tMs);
        outcome = `t=${action.sample.tMs}`;
        break;
      case 'benchPushFps':
        model.recorder.pushFps(action.sample);
        model.bench.fps.push({ ...action.sample });
        observeT(model.bench, action.sample.tMs);
        outcome = `t=${action.sample.tMs},fps=${action.sample.fps}`;
        break;
      case 'benchPushMemory':
        model.recorder.pushMemory(action.sample);
        model.bench.memory.push({ ...action.sample });
        observeT(model.bench, action.sample.tMs);
        outcome = `t=${action.sample.tMs}`;
        break;
      case 'benchCapture':
        model.recorder.pushCapture(action.capture);
        model.bench.captures.push({ ...action.capture });
        observeT(model.bench, action.capture.finalizedAtMs);
        outcome = `t=${action.capture.finalizedAtMs}`;
        break;
      case 'benchNote':
        model.recorder.addNote(action.note);
        model.bench.notes.push(action.note);
        outcome = `len=${action.note.length}`;
        break;
      case 'benchFinalize': {
        const expectedDoc = modelDocument(model.bench, action.reasons);
        const problems = oracleBenchProblems(model.bench, action.reasons);
        const reasonsSnap = stableJson(action.reasons);
        let first: { ok: true; doc: unknown } | { ok: false; message: string };
        try {
          first = { ok: true, doc: model.recorder.finalize(action.reasons) };
        } catch (error) {
          first = { ok: false, message: errorMessage(error) };
        }
        let second: { ok: true; doc: unknown } | { ok: false; message: string };
        try {
          second = { ok: true, doc: model.recorder.finalize(action.reasons) };
        } catch (error) {
          second = { ok: false, message: errorMessage(error) };
        }
        must(
          stableJson(action.reasons) === reasonsSnap,
          'I-PURE',
          () => 'finalize mutated reasons',
        );
        must(
          deepEqual(first, second),
          'I-BENCH',
          () => 'finalize not repeatable',
        );
        // The oracle's document must agree with the real validator too.
        const oracleErrors = errorPrefixes(
          validateDeviceBenchExport(expectedDoc),
        );
        must(
          deepEqual(oracleErrors, problems),
          'I-BENCHV',
          () =>
            `validator ${short(oracleErrors)} ≠ oracle ${short(problems)} on model doc`,
        );
        if (problems.length === 0) {
          must(
            first.ok,
            'I-BENCH',
            () =>
              `finalize threw on a valid recorder: ${short(first.ok ? null : first.message)}`,
          );
          must(
            first.ok && deepEqual(first.doc, expectedDoc),
            'I-BENCH',
            () =>
              `doc ${short(first.ok ? first.doc : null, 800)} ≠ model ${short(expectedDoc, 800)}`,
          );
          must(
            first.ok && validateDeviceBenchExport(first.doc).length === 0,
            'I-BENCH',
            () =>
              `finalize output fails validation: ${short(first.ok ? validateDeviceBenchExport(first.doc) : null)}`,
          );
          if (first.ok) {
            const doc = first.doc as Payload;
            (doc.notes as string[]).push('tamper');
            ((doc.thermal as Payload).samples as unknown[]).push({
              tMs: 0,
              state: 'hot',
            });
            (doc.captures as unknown[]).push({});
            must(
              deepEqual(model.recorder.finalize(action.reasons), expectedDoc),
              'I-BENCHCOPY',
              () => 'mutating the exported doc changed the recorder',
            );
          }
          stats.benchFinalizeOk += 1;
          outcome = `ok:dur=${model.bench.lastTMs}`;
        } else {
          must(
            !first.ok,
            'I-BENCH',
            () =>
              `finalize emitted an invalid doc; expected problems ${short(problems)}`,
          );
          const message = first.ok ? '' : first.message;
          must(
            message.startsWith('device-bench export invalid: '),
            'I-BENCH',
            () => `unexpected message ${short(message)}`,
          );
          for (const p of problems) {
            must(
              message.includes(`${p}:`),
              'I-BENCH',
              () => `finalize error omits "${p}": ${short(message, 400)}`,
            );
          }
          stats.benchFinalizeThrew += 1;
          outcome = `threw:${problems.length}`;
        }
        break;
      }
      case 'benchValidate': {
        const doc = validBenchDocument();
        must(
          validateDeviceBenchExport(doc).length === 0,
          'I-BENCHV',
          () => `fixture rejected: ${short(validateDeviceBenchExport(doc))}`,
        );
        const mutation = BENCH_DOC_MUTATIONS[action.mutation];
        must(
          mutation !== undefined,
          'I-BENCHV',
          () => `unknown mutation ${action.mutation}`,
        );
        if (!mutation) break;
        mutation.apply(doc);
        const errors = validateDeviceBenchExport(doc);
        must(
          Array.isArray(errors) &&
            errors.every(e => typeof e === 'string' && e.length > 0),
          'I-BENCHV',
          () => 'validator returned non-strings',
        );
        must(
          deepEqual(errorPrefixes(errors), [...mutation.expect].sort()),
          'I-BENCHV',
          () =>
            `${action.mutation}: ${short(errorPrefixes(errors))} ≠ ${short(mutation.expect)}`,
        );
        for (const junk of [
          null,
          undefined,
          5,
          'doc',
          [],
          {},
          { schemaVersion: 1 },
        ]) {
          let threw = false;
          try {
            const junkErrors = validateDeviceBenchExport(junk);
            must(
              junkErrors.length > 0,
              'I-BENCHV',
              () => `junk ${short(junk)} validated clean`,
            );
          } catch (error) {
            if (error instanceof InvariantViolation) throw error;
            threw = true;
          }
          must(
            !threw,
            'I-BENCHV',
            () => `validator threw on junk ${short(junk)}`,
          );
        }
        outcome = `${action.mutation}:${errors.length}`;
        break;
      }
      case 'benchFilename': {
        const name = deviceBenchExportFilename(action.iso);
        must(
          name === deviceBenchExportFilename(action.iso),
          'I-FNAME',
          () => 'filename not deterministic',
        );
        must(
          /^device-bench-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/.test(
            name,
          ),
          'I-FNAME',
          () => `unsafe filename ${name}`,
        );
        const other = new Date(Date.parse(action.iso) + 1).toISOString();
        must(
          deviceBenchExportFilename(other) !== name,
          'I-FNAME',
          () => `collision ${action.iso} vs ${other}`,
        );
        outcome = name;
        break;
      }
    }
    stats.nativeCalls += sim.script.calls.length - callsBefore;
    return outcome;
  };

  let ok = true;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i] as Action;
    const { kind, ...params } = action;
    const paramsJson = stableJson(params);
    let outcome: string;
    try {
      outcome = await step(action, i);
      checkGlobal();
    } catch (error) {
      ok = false;
      const invariant =
        error instanceof InvariantViolation ? error.invariant : 'I-CRASH';
      const detail =
        error instanceof InvariantViolation
          ? error.detail
          : `${errorMessage(error)}${error instanceof Error && error.stack ? `\n${error.stack.split('\n').slice(1, 4).join('\n')}` : ''}`;
      failures.push({ invariant, step: i, kind, detail, params: paramsJson });
      outcome = `FAIL:${invariant}`;
    }
    stats.steps += 1;
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
    trace.push({ i, kind, params: paramsJson, outcome });
    if (!ok) break;
  }

  screen();
  for (const s of model.subscribers) if (s.live) s.unsubscribe();
  return { seed, length: actions.length, ok, failures, trace, stats };
}

export async function runSequence(
  seed: number,
  env: HarnessEnv,
): Promise<SequenceResult> {
  return runActions(generateActions(seed), env, seed);
}

export function traceKey(result: SequenceResult): string {
  return stableJson(result.trace.map(t => [t.kind, t.params, t.outcome]));
}

/** ddmin over the action list; keeps the FIRST failure's invariant id as the oracle. */
export async function minimizeActions(
  actions: Action[],
  env: HarnessEnv,
  seed: number,
  invariant: string,
): Promise<{ actions: Action[]; result: SequenceResult; runs: number }> {
  let runs = 0;
  const fails = async (candidate: Action[]) => {
    runs += 1;
    const result = await runActions(candidate, env, seed);
    return {
      failing: !result.ok && result.failures[0]?.invariant === invariant,
      result,
    };
  };
  let current = actions;
  let currentResult = (await fails(current)).result;
  let n = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const complement = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (complement.length === 0) continue;
      const attempt = await fails(complement);
      if (attempt.failing) {
        current = complement;
        currentResult = attempt.result;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }
  return { actions: current, result: currentResult, runs };
}

export { deriveSeed };
