/**
 * Seed data for the FormReviewScreen stress harness: one scored forehand
 * drive with a full analysis record, a captured clip row and a pose sidecar
 * whose SHA-256 the capture row vouches for. Everything is written with the
 * same SQL the production repository uses so the screen reads REAL rows
 * through REAL migrations, not a hand-built evidence object.
 */
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';
import type { DatabaseSync } from './opSqliteDouble';

export const OWNER = 'device-guest';
export const ANALYSIS_ID = 'stress-analysis-1';
export const SIBLING_ANALYSIS_ID = 'stress-analysis-2';
export const SESSION_ID = 'stress-set-1';
export const CAPTURE_ID = 'stress-capture-1';
export const CLIP_URI = 'file:///captures/stress-clip.mov';
export const POSTER_URI = 'file:///captures/stress-clip.poster.jpg';
export const SIDECAR_URI = 'file:///captures/stress-clip.pose.json';
export const CAPTURED_AT = '2026-09-01T10:00:00.000Z';
export const CLIP_DURATION_MS = 3400;
export const POSE_MODEL_VERSION = 'apple-vision-bodypose-1';

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

export function makeAnalysis(
  overrides: Partial<ShotAnalysis> = {},
): ShotAnalysis {
  return {
    id: ANALYSIS_ID,
    sessionId: SESSION_ID,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: CAPTURED_AT,
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
      poseModelVersion: POSE_MODEL_VERSION,
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
    ...overrides,
  };
}

// ─── Pose sidecar (wire format the native capture layer writes) ─────────────

export interface WireLandmark {
  n: string;
  x: number;
  y: number;
  v: number;
}
export interface WireFrame {
  i: number;
  t: number;
  c: number;
  l: WireLandmark[];
}
export interface WireSequence {
  schemaVersion: number;
  format: string;
  coordinateSystem: string;
  poseModelVersion: string;
  video: { w: number; h: number; fps: number };
  frames: WireFrame[];
}

const JOINTS = [
  'head',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

/** 40ms frames of a full body; the right wrist sweeps left → right. */
export function makeWireSequence(): WireSequence {
  const frames: WireFrame[] = [];
  let index = 0;
  // Frames cover the whole clip (every 40ms through CLIP_DURATION_MS) so the
  // end-of-clip stop still has a recorded frame within tolerance.
  for (let t = 0; t <= CLIP_DURATION_MS; t += 40) {
    const sweep = Math.min(1, t / 3200);
    const at = (name: string): { x: number; y: number } => {
      switch (name) {
        case 'head':
          return { x: 0.5, y: 0.18 };
        case 'left_shoulder':
          return { x: 0.45, y: 0.3 };
        case 'right_shoulder':
          return { x: 0.55, y: 0.3 };
        case 'left_elbow':
          return { x: 0.4, y: 0.42 };
        case 'right_elbow':
          return { x: 0.62, y: 0.42 };
        case 'left_wrist':
          return { x: 0.38, y: 0.52 };
        case 'right_wrist':
          return { x: 0.3 + 0.4 * sweep, y: 0.5 };
        case 'left_hip':
          return { x: 0.46, y: 0.55 };
        case 'right_hip':
          return { x: 0.54, y: 0.55 };
        case 'left_knee':
          return { x: 0.46, y: 0.72 };
        case 'right_knee':
          return { x: 0.54, y: 0.72 };
        case 'left_ankle':
          return { x: 0.45, y: 0.9 };
        default:
          return { x: 0.55, y: 0.9 };
      }
    };
    frames.push({
      i: index,
      t,
      c: 0.9,
      l: JOINTS.map(name => ({ n: name, ...at(name), v: 0.95 })),
    });
    index += 1;
  }
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: POSE_MODEL_VERSION,
    video: { w: 1080, h: 1920, fps: 30 },
    frames,
  };
}

export interface SidecarRef {
  schemaVersion: 1;
  format: 'pickle.pose-sequence.v1';
  uri: string;
  frameCount: number;
  sha256: string;
  coordinateSystem: 'normalized_image_top_left';
  poseModelVersion: string;
}

/** A sidecar reference that vouches for exactly `json` (byte-identical). */
export function sidecarRefFor(json: string, frameCount: number): SidecarRef {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: SIDECAR_URI,
    frameCount,
    sha256: sha256Hex(json),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: POSE_MODEL_VERSION,
  };
}

// ─── Rows ────────────────────────────────────────────────────────────────────

export interface CaptureRowOverrides {
  duration_ms?: number | string | null;
  fps?: number | string | null;
  width?: number | string | null;
  height?: number | string | null;
  uri?: string;
  captured_at?: string;
  /** `undefined` → the honest payload; `null` → legacy row; string → as-is. */
  payload?: string | null;
}

/** A `CapturedClip` that passes the production `assertCapturedClip`
 * validator (imported-video shape: recognition + not-run ball speed, and
 * the pose sidecar ref the explicit extraction pass would have written). */
export function capturePayload(sidecar: SidecarRef | null): string {
  return JSON.stringify({
    captureMode: 'imported_video',
    uri: CLIP_URI,
    capturedAtIso: CAPTURED_AT,
    durationMs: CLIP_DURATION_MS,
    fps: 30,
    width: 1080,
    height: 1920,
    posterUri: POSTER_URI,
    recognition: {
      status: 'recognized',
      shotType: 'drive_forehand',
      confidence: 0.82,
      modelVersion: 'stroke-recognizer-1',
    },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    ...(sidecar ? { poseSequence: sidecar } : {}),
  });
}

export function insertShot(
  db: DatabaseSync,
  analysis: ShotAnalysis,
  payload: string = JSON.stringify(analysis),
): void {
  db.prepare(
    `INSERT OR REPLACE INTO local_shot
     (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    OWNER,
    analysis.id,
    analysis.sessionId,
    analysis.shotType,
    analysis.capturedAtIso,
    analysis.overallScore,
    analysis.analysisConfidence,
    analysis.resultKind,
    analysis.source,
    payload,
  );
}

export function insertRecord(
  db: DatabaseSync,
  analysisId: string,
  captureId: string,
  record: string = JSON.stringify({
    id: analysisId,
    captureId,
    createdAtIso: CAPTURED_AT,
    engineVersion: 'on-device-fusion-1',
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
      analysisConfidence: 0.84,
      presentation: 'normal',
      limitingFactors: [],
    },
  }),
): void {
  db.prepare(
    `INSERT INTO local_analysis_record
     (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    OWNER,
    analysisId,
    captureId,
    CAPTURED_AT,
    'on-device-fusion-1',
    'sm-v1',
    record,
  );
}

export function insertCapture(
  db: DatabaseSync,
  sidecar: SidecarRef | null,
  overrides: CaptureRowOverrides = {},
): void {
  const payload =
    overrides.payload === undefined
      ? capturePayload(sidecar)
      : overrides.payload;
  db.prepare(
    `INSERT INTO local_capture
     (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzed', ?)`,
  ).run(
    OWNER,
    CAPTURE_ID,
    overrides.uri ?? CLIP_URI,
    'forehand_drive',
    'forehand_drive',
    overrides.captured_at ?? CAPTURED_AT,
    overrides.duration_ms === undefined
      ? CLIP_DURATION_MS
      : overrides.duration_ms,
    overrides.fps === undefined ? 30 : overrides.fps,
    overrides.width === undefined ? 1080 : overrides.width,
    overrides.height === undefined ? 1920 : overrides.height,
    payload,
  );
}
