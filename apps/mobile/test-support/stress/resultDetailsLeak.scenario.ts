/**
 * Seeded scenario model for the ResultDetailsScreen long-run-leak campaign.
 *
 * Pure: no jest globals, no React. Every iteration of the campaign is
 * described by ONE seed; `scenarioFor(seed)` derives the data the local
 * SQLite store holds for that iteration (analysis, record, capture row,
 * pose sidecar, sibling attempts, outbox / receipt state), the API session
 * and training-store configuration, the interaction performed while the
 * screen is mounted, and how the unmount is timed. Replaying a seed
 * reproduces exactly the same iteration.
 */
import { generateSwingSequence } from '@pickle/evaluation';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type {
  CapturedClip,
  PoseSequenceSidecarRef,
} from '../../src/camera/capture';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';

// ─── Seeded RNG (mulberry32) ────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, options: readonly T[]): T {
  const index = Math.floor(random() * options.length);
  const value = options[index];
  if (value === undefined) throw new Error('empty option list');
  return value;
}

/** RFC 4122 v4-shaped id derived from the seed so every row is replayable. */
export function seededUuid(random: () => number): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i += 1) {
    if (i === 12) out += '4';
    else if (i === 16) out += hex[8 + Math.floor(random() * 4)];
    else out += hex[Math.floor(random() * 16)];
    if (i === 7 || i === 11 || i === 15 || i === 19) out += '-';
  }
  return out;
}

// ─── Scenario dimensions ────────────────────────────────────────────────────

export const EVIDENCE_KINDS = [
  /** Real scored analysis + record + capture row with a valid pose sidecar. */
  'scored_full',
  /** Scored, capture row present but the clip carries no sidecar ref. */
  'scored_no_sidecar',
  /** Scored, sidecar ref whose sha256 does not match the file bytes. */
  'scored_sidecar_mismatch',
  /** Scored analysis whose session id is null → no attempt chips. */
  'scored_no_session',
  /** Engine abstained: record without a result, no scored local_shot row. */
  'abstained',
  /** Nothing stored under the id → missing-result state. */
  'missing',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const SYNC_STATES = [
  'queued',
  'synced',
  'rejected',
  'exhausted',
] as const;
export type SyncState = (typeof SYNC_STATES)[number];

export const TRAINING_MODES = [
  /** No training API configured (store reports `unconfigured`). */
  'unconfigured',
  /** Real createTrainingApi over the mocked fetch; server returns plan:null. */
  'configured_no_plan',
  /** Real createTrainingApi over the mocked fetch; the request rejects. */
  'configured_offline',
] as const;
export type TrainingMode = (typeof TRAINING_MODES)[number];

export const INTERACTIONS = [
  'none',
  /** Tap the form-review entry card → navigation.navigate('FormReview'). */
  'open_form_review',
  /** Tap a sibling attempt chip → navigation.popTo('Result'). */
  'open_attempt',
  /** Tap the replay play button and unmount while the interval is live. */
  'start_replay',
  /** Tap the replay play button, then pause it again before unmount. */
  'toggle_replay',
  /** Expand the measured-rows disclosure. */
  'expand_rows',
  /** Header back → navigation.goBack(). */
  'back',
  /** Tap "accurate" on the feedback prompt (synced + session only). */
  'feedback',
] as const;
export type Interaction = (typeof INTERACTIONS)[number];

export const UNMOUNT_TIMINGS = [
  /** Unmount after the evidence, sidecar and sync reads all settled. */
  'settled',
  /** Unmount while the first DB read is still pending, then release it. */
  'during_load',
] as const;
export type UnmountTiming = (typeof UNMOUNT_TIMINGS)[number];

export interface SiblingAttempt {
  analysisId: string;
  capturedAtIso: string;
}

export interface Scenario {
  seed: number;
  analysisId: string;
  captureId: string;
  sessionId: string | null;
  owner: string;
  capturedAtIso: string;
  evidence: EvidenceKind;
  sync: SyncState;
  training: TrainingMode;
  session: boolean;
  interaction: Interaction;
  unmount: UnmountTiming;
  siblings: SiblingAttempt[];
  /** Depth of the stack under the ResultDetails route (1..3). */
  stackDepth: number;
  overallScore: number;
}

export function scenarioFor(seed: number): Scenario {
  const random = mulberry32(seed);
  const analysisId = seededUuid(random);
  const captureId = seededUuid(random);
  const owner = seededUuid(random);
  const evidence = pick(random, EVIDENCE_KINDS);
  const sessionId =
    evidence === 'scored_no_session' ? null : seededUuid(random);
  const sync = pick(random, SYNC_STATES);
  const training = pick(random, TRAINING_MODES);
  const session = random() < 0.5;
  const unmount = random() < 0.2 ? 'during_load' : 'settled';
  const siblingCount = sessionId ? Math.floor(random() * 4) : 0;
  const base = Date.UTC(2026, 8, 1, 10, 0, 0);
  const siblings: SiblingAttempt[] = [];
  for (let i = 0; i < siblingCount; i += 1) {
    siblings.push({
      analysisId: seededUuid(random),
      capturedAtIso: new Date(base - (i + 1) * 5 * 60_000).toISOString(),
    });
  }
  let interaction = pick(random, INTERACTIONS);
  const scored = evidence.startsWith('scored');
  if (unmount === 'during_load') interaction = 'none';
  else if (!scored && interaction !== 'back') interaction = 'none';
  else if (interaction === 'open_attempt' && siblings.length === 0)
    interaction = 'none';
  else if (interaction === 'feedback' && !(sync === 'synced' && session))
    interaction = 'none';
  const stackDepth = 1 + Math.floor(random() * 3);
  const overallScore = Math.round((4 + random() * 5.5) * 10) / 10;
  return {
    seed,
    analysisId,
    captureId,
    sessionId,
    owner,
    capturedAtIso: new Date(base).toISOString(),
    evidence,
    sync,
    training,
    session,
    interaction,
    unmount,
    siblings,
    stackDepth,
    overallScore,
  };
}

// ─── Fixtures (same shapes as the result guide suites) ──────────────────────

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

export function scoredAnalysis(
  scenario: Pick<
    Scenario,
    'analysisId' | 'sessionId' | 'capturedAtIso' | 'overallScore'
  >,
): ShotAnalysis {
  return {
    id: scenario.analysisId,
    sessionId: scenario.sessionId,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: scenario.capturedAtIso,
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
    overallScore: scenario.overallScore,
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
}

export function evidenceRecord(
  scenario: Pick<Scenario, 'analysisId' | 'captureId'>,
  abstained: boolean,
): StrokeResultEvidenceRecord {
  return {
    id: scenario.analysisId,
    captureId: scenario.captureId,
    strokeIntent: {
      declaredStroke: 'forehand_drive',
      predictedStroke: null,
      resolutionBasis: 'declared',
      resolvedProfileId: 'FOREHAND_DRIVE',
      resolvedProfileVersion: 'technique-profile-v1',
      disagreement: null,
    },
    result: null,
    uncertainty: {
      analysisConfidence: abstained ? 0.31 : 0.84,
      presentation: abstained ? 'abstained' : 'normal',
      limitingFactors: [
        'paddle_track_unavailable',
        'ball_track_unavailable',
        'court_geometry_unavailable',
      ],
    },
  };
}

export interface PoseSidecarFixture {
  json: string;
  ref: PoseSequenceSidecarRef;
  frameCount: number;
}

/** One deterministic synthetic sidecar shared by the whole campaign (the
 * bytes are what the native reader returns; each scenario decides whether
 * its ref's hash matches those bytes). */
export function buildPoseSidecar(uri: string): PoseSidecarFixture {
  const { sequence } = generateSwingSequence();
  const json = serializePoseSequence(sequence);
  return {
    json,
    frameCount: sequence.frames.length,
    ref: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(json),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

export function capturedClip(
  scenario: Pick<Scenario, 'captureId' | 'capturedAtIso' | 'evidence'>,
  sidecar: PoseSidecarFixture,
): CapturedClip {
  const poseSequence: PoseSequenceSidecarRef | undefined =
    scenario.evidence === 'scored_no_sidecar'
      ? undefined
      : scenario.evidence === 'scored_sidecar_mismatch'
        ? { ...sidecar.ref, sha256: 'ab'.repeat(32) }
        : sidecar.ref;
  return {
    uri: `file:///private/captures/${scenario.captureId}.mov`,
    posterUri: `file:///private/captures/${scenario.captureId}.poster.jpg`,
    durationMs: 3400,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: scenario.capturedAtIso,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1800,
      endMs: 2450,
      peakMotionMs: 2220,
      confidence: 0.84,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'mediapipe_pose_landmarker',
      poseModelVersion: 'mediapipe-pose-landmarker-full-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 8,
      poseFrameCount: 7,
      poseMissingFrameCount: 1,
      trackedDurationMs: 600,
      meanCanonicalJointVisibility: 0.86,
      meanJointCoverage: 0.93,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 5,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 6,
          meanNormalizedPerSecond: 1.2,
          peakNormalizedPerSecond: 2.1,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1800,
    postRollMs: 1450,
    ...(poseSequence ? { poseSequence } : {}),
  };
}

// ─── Leak statistics ────────────────────────────────────────────────────────

export interface HeapPoint {
  iteration: number;
  heapUsed: number;
}

export interface HeapSlope {
  /** Least-squares slope in bytes per iteration. */
  bytesPerIteration: number;
  /** Slope over 100 iterations as a percentage of the first checkpoint. */
  percentPer100: number;
  /** Share of consecutive checkpoints where heap grew (1 = strictly monotone). */
  monotoneShare: number;
  first: number;
  last: number;
  points: number;
}

export function heapSlope(points: HeapPoint[]): HeapSlope | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.iteration, 0) / n;
  const meanY = points.reduce((s, p) => s + p.heapUsed, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.iteration - meanX) * (p.heapUsed - meanY);
    den += (p.iteration - meanX) ** 2;
  }
  const bytesPerIteration = den === 0 ? 0 : num / den;
  const first = points[0]?.heapUsed ?? 0;
  const last = points[n - 1]?.heapUsed ?? 0;
  let ups = 0;
  for (let i = 1; i < n; i += 1) {
    const prev = points[i - 1]?.heapUsed ?? 0;
    const cur = points[i]?.heapUsed ?? 0;
    if (cur > prev) ups += 1;
  }
  return {
    bytesPerIteration,
    percentPer100: first === 0 ? 0 : ((bytesPerIteration * 100) / first) * 100,
    monotoneShare: ups / (n - 1),
    first,
    last,
    points: n,
  };
}

export function mean(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((s, v) => s + v, 0) / values.length;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((p / 100) * (sorted.length - 1))),
  );
  return sorted[index] ?? 0;
}
