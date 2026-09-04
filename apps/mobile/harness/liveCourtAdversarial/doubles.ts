/**
 * STATE-MACHINE DOUBLES for the Live Court adversarial harness. These are
 * shape-faithful AnalysisRecord / SessionEventView / LiveSessionSnapshot
 * builders for driving the coach and flow seams at scale. They are never
 * product results — no measurement claims derive from them.
 */
import type { AnalysisRecord } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  FaultDirection,
  ShotTypeSlug,
} from '@pickle/shared-types';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../src/flow/session';

export interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
  applicable?: boolean;
}

function recordBase(
  id: string,
  shotType: ShotTypeSlug,
): Omit<AnalysisRecord, 'result'> {
  return {
    schemaVersion: 1,
    id,
    captureId: `capture-${id}`,
    createdAtIso: '2026-01-01T00:00:00.000Z',
    engineVersion: 'adversarial-double',
    strokeTaxonomyVersion: 'adversarial-double',
    strokeResolution: { kind: 'declared', shotType },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    provenance: {
      appVersion: 'adversarial-double',
      pipelineVersion: 'adversarial-double',
      providerVersions: [
        {
          providerId: 'adversarial-double',
          modelVersion: 'adversarial-double',
          runtime: 'deterministic',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      ],
      scoreVersion: 'adversarial-double',
      taxonomyVersion: 'adversarial-double',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: '2026-01-01T00:00:00.000Z',
    },
    faults: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      perCheckpoint: {},
      limitingFactors: ['ADVERSARIAL_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  } as unknown as Omit<AnalysisRecord, 'result'>;
}

/** Scored double: the fields the coach policy reads are exact; the rest is
 * structurally valid filler. */
export function scoredAnalysis(
  id: string,
  overallScore: number,
  checkpoints: CheckpointSpec[],
  shotType: ShotTypeSlug = 'forehand_drive',
): AnalysisRecord {
  const result = {
    id,
    sessionId: null,
    shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-01-01T00:00:00.000Z',
    timestamps: { startMs: 0, contactMs: null, endMs: 1 },
    phases: [],
    measurements: [],
    checkpoints: checkpoints.map(spec => ({
      key: spec.key,
      score: spec.score,
      confidence: 0.9,
      band: 'yellow',
      direction: spec.direction,
      severity: spec.severity,
      applicable: spec.applicable ?? true,
    })),
    overallScore,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {},
    source: 'fixture',
  };
  return { ...recordBase(id, shotType), result } as unknown as AnalysisRecord;
}

export function lowConfidenceAnalysis(id: string): AnalysisRecord {
  const result = {
    id,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-01-01T00:00:00.000Z',
    timestamps: { startMs: 0, contactMs: null, endMs: 1 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: null,
    analysisConfidence: 0.1,
    resultKind: 'low_confidence',
    guidance: null,
    priorityFix: null,
    versionVector: {},
    source: 'fixture',
  };
  return {
    ...recordBase(id, 'forehand_drive'),
    result,
  } as unknown as AnalysisRecord;
}

/** `result: null` — the honest "record exists, nothing scored" shape. */
export function nullResultAnalysis(id: string): AnalysisRecord {
  return {
    ...recordBase(id, 'forehand_drive'),
    result: null,
  } as AnalysisRecord;
}

/**
 * MALFORMED records — outside the type contract on purpose (what a corrupted
 * persisted record or a buggy provider could hand the coach). Cast through
 * unknown; the harness measures how the coach copes, never assumes.
 */
export type MalformedKind =
  | 'scored_nan_overall'
  | 'scored_infinite_overall'
  | 'scored_missing_checkpoints'
  | 'scored_null_checkpoints'
  | 'scored_checkpoint_nan_score'
  | 'scored_checkpoint_missing_key'
  | 'scored_checkpoint_bad_direction'
  | 'scored_negative_overall'
  | 'scored_overall_above_ten'
  | 'result_not_object';

export const MALFORMED_KINDS: readonly MalformedKind[] = [
  'scored_nan_overall',
  'scored_infinite_overall',
  'scored_missing_checkpoints',
  'scored_null_checkpoints',
  'scored_checkpoint_nan_score',
  'scored_checkpoint_missing_key',
  'scored_checkpoint_bad_direction',
  'scored_negative_overall',
  'scored_overall_above_ten',
  'result_not_object',
];

export function malformedAnalysis(
  id: string,
  kind: MalformedKind,
): AnalysisRecord {
  const base = scoredAnalysis(id, 6.4, [
    { key: 'athletic_base', score: 40, direction: 'low', severity: 0.5 },
  ]) as unknown as { result: Record<string, unknown> };
  const result: Record<string, unknown> = { ...base.result };
  switch (kind) {
    case 'scored_nan_overall':
      result.overallScore = Number.NaN;
      break;
    case 'scored_infinite_overall':
      result.overallScore = Number.POSITIVE_INFINITY;
      break;
    case 'scored_missing_checkpoints':
      delete result.checkpoints;
      break;
    case 'scored_null_checkpoints':
      result.checkpoints = null;
      break;
    case 'scored_checkpoint_nan_score':
      result.checkpoints = [
        {
          key: 'athletic_base',
          score: Number.NaN,
          confidence: 0.9,
          band: 'yellow',
          direction: 'low',
          severity: 0.5,
          applicable: true,
        },
      ];
      break;
    case 'scored_checkpoint_missing_key':
      result.checkpoints = [
        {
          score: 40,
          confidence: 0.9,
          band: 'yellow',
          direction: 'low',
          severity: 0.5,
          applicable: true,
        },
      ];
      break;
    case 'scored_checkpoint_bad_direction':
      result.checkpoints = [
        {
          key: 'athletic_base',
          score: 40,
          confidence: 0.9,
          band: 'yellow',
          direction: 'sideways',
          severity: 0.5,
          applicable: true,
        },
      ];
      break;
    case 'scored_negative_overall':
      result.overallScore = -3.2;
      break;
    case 'scored_overall_above_ten':
      result.overallScore = 42;
      break;
    case 'result_not_object':
      return { ...base, result: 'garbage' } as unknown as AnalysisRecord;
  }
  return { ...base, result } as unknown as AnalysisRecord;
}

// ─── Event views & snapshots ────────────────────────────────────────────────

export function eventView(
  index: number,
  partial: Partial<SessionEventView> = {},
): SessionEventView {
  return {
    eventId: `E${index + 1}`,
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 400,
    peakMs: index * 1000 + 200,
    durationMs: 400,
    peakSpeed: 2.5,
    paddleConfirmed: true,
    closeReason: 'settle',
    closedAtMs: index * 1000 + 600,
    state: 'pending',
    pendingReason: null,
    abstainReason: null,
    analysis: null,
    family: null,
    boundaryUncertain: false,
    retroSuppressed: false,
    ...partial,
  };
}

export function snapshotOf(
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  return {
    sessionId: 'adversarial-session',
    phase: 'running',
    source: 'live',
    startedAtIso: '2026-08-31T10:00:00.000Z',
    durationMs: events.length * 1000 + 600,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'adversarial-engine',
    analysisProviderId: 'adversarial-provider',
    ...overrides,
  };
}

export const KNEE_FAULT: CheckpointSpec = {
  key: 'athletic_base',
  score: 40,
  direction: 'low',
  severity: 0.5,
};

export const CLEAN_CHECKPOINTS: CheckpointSpec[] = [
  { key: 'contact_position', score: 88, direction: 'none', severity: 0.05 },
  { key: 'athletic_base', score: 90, direction: 'none', severity: 0.02 },
];

export const FAULT_CHECKPOINT_KEYS: readonly CheckpointKey[] = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
];

export const FAULT_DIRECTIONS: readonly FaultDirection[] = [
  'late',
  'early',
  'high',
  'low',
  'long',
  'short',
  'wide',
  'narrow',
  'open',
  'closed',
  'unstable',
];
