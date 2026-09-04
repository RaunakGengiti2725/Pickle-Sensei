/**
 * Deterministic synthetic data for the SQLite/sync performance harness.
 *
 * Every builder is a pure function of (seed, index) so a failing scenario is
 * replayable from the seed recorded in the run's report.json. Shapes match the
 * production domain types so the REAL repository/sync serializers accept the
 * rows (source 'real', resultKind 'scored', a full checkpoint set, a permit id).
 */
import type {
  CheckpointScore,
  Measurement,
  PhaseSpan,
  ShotAnalysis,
  ShotTypeSlug,
} from '@pickle/shared-types';
import { CHECKPOINTS, PHASES, SHOT_TYPES } from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import { ANALYSIS_RECORD_SCHEMA_VERSION } from '@pickle/swing-domain';
import type { CapturedClip } from '../../src/camera/capture';

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, deterministic. */
export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: maxExclusive => Math.floor(next() * maxExclusive),
    pick: items => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('pick from empty list');
      return item;
    },
  };
}

const HEX = '0123456789abcdef';

/** RFC 4122 v4-shaped id (accountScope's canonical owner check needs it). */
export function syntheticUuid(rng: Rng): string {
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) out += '-';
    else if (i === 14) out += '4';
    else if (i === 19) out += HEX[8 + rng.int(4)];
    else out += HEX[rng.int(16)];
  }
  return out;
}

export interface ShotFixtureOptions {
  index: number;
  total: number;
  /** ISO timestamp of the newest shot; older shots spread back over `spanDays`. */
  newestIso: string;
  spanDays: number;
  sessionIds: readonly string[];
  /** Fraction of rows linked to a session (default 0.6). */
  sessionRatio?: number;
  /** Fraction of rows with resultKind 'low_confidence' (null overall score). */
  lowConfidenceRatio: number;
}

export function buildShotAnalysis(
  rng: Rng,
  options: ShotFixtureOptions,
): ShotAnalysis {
  const newestMs = Date.parse(options.newestIso);
  const spanMs = options.spanDays * 24 * 60 * 60 * 1000;
  // Oldest first so captured_at is monotone with index (real usage), with a
  // little jitter so ties and near-ties exercise the ORDER BY paths.
  const offset =
    ((options.total - 1 - options.index) / Math.max(1, options.total)) *
      spanMs +
    rng.int(60_000);
  const capturedAtMs = newestMs - offset;
  const lowConfidence = rng.next() < options.lowConfidenceRatio;
  const shotType: ShotTypeSlug = rng.pick(SHOT_TYPES);
  const contactMs = 1400 + rng.int(400);

  const phases: PhaseSpan[] = PHASES.map((key, i) => ({
    key,
    startMs: i * 350,
    representativeMs: i * 350 + 175,
    endMs: (i + 1) * 350,
    confidence: 0.6 + rng.next() * 0.4,
  }));

  const measurements: Measurement[] = [];
  for (let i = 0; i < 24; i += 1) {
    measurements.push({
      metricKey: `metric_${i}`,
      value: Number((rng.next() * 180).toFixed(3)),
      confidence: Number((0.5 + rng.next() * 0.5).toFixed(3)),
      unit: i % 3 === 0 ? 'degrees' : i % 3 === 1 ? 'normalized' : 'ms',
      source: 'real',
    });
  }

  const checkpoints: CheckpointScore[] = CHECKPOINTS.map(key => {
    const score = lowConfidence ? null : 40 + rng.int(60);
    return {
      key,
      score,
      confidence: Number((0.4 + rng.next() * 0.6).toFixed(3)),
      band:
        score === null
          ? 'unscored'
          : score >= 80
            ? 'green'
            : score >= 60
              ? 'yellow'
              : 'red',
      direction: score !== null && score < 60 ? 'late' : 'none',
      severity: score === null ? 0 : Number(((100 - score) / 100).toFixed(3)),
      applicable: true,
    };
  });

  const overall = lowConfidence
    ? null
    : Math.round(
        checkpoints.reduce((sum, c) => sum + (c.score ?? 0), 0) /
          checkpoints.length,
      );
  const worst = checkpoints
    .filter(c => c.score !== null)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0];

  return {
    id: syntheticUuid(rng),
    sessionId:
      options.sessionIds.length > 0 &&
      rng.next() < (options.sessionRatio ?? 0.6)
        ? rng.pick(options.sessionIds)
        : null,
    shotType,
    cameraView: rng.next() < 0.8 ? 'side' : 'rear_oblique',
    handedness: rng.next() < 0.9 ? 'right' : 'left',
    capturedAtIso: new Date(capturedAtMs).toISOString(),
    timestamps: { startMs: 0, contactMs, endMs: 2100 },
    phases,
    measurements,
    checkpoints,
    overallScore: overall,
    analysisConfidence: Number((0.5 + rng.next() * 0.5).toFixed(3)),
    resultKind: lowConfidence ? 'low_confidence' : 'scored',
    guidance: lowConfidence
      ? null
      : 'Keep the paddle set earlier and finish through the target line.',
    priorityFix:
      worst && !lowConfidence
        ? {
            checkpoint: worst.key,
            reasonKey: 'lowest_score',
            severity: worst.severity,
            confidence: worst.confidence,
          }
        : null,
    versionVector: {
      appVersion: '1.0.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'paddle-none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'shot-config-1',
    },
    source: 'real',
  };
}

export function buildCapturedClip(
  rng: Rng,
  index: number,
  capturedAtIso: string,
): CapturedClip {
  return {
    uri: `file:///private/captures/perf-${index}.mov`,
    durationMs: 3200 + rng.int(1600),
    fps: 59.94,
    width: 720,
    height: 1280,
    byteSize: 4_000_000 + rng.int(3_000_000),
    capturedAtIso,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1800,
      endMs: 2450,
      peakMotionMs: 2220,
      confidence: Number((0.6 + rng.next() * 0.4).toFixed(3)),
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
  };
}

export function buildAnalysisRecord(
  rng: Rng,
  captureId: string,
  analysis: ShotAnalysis,
): AnalysisRecord {
  const createdAtIso = analysis.capturedAtIso;
  const poseRef = {
    providerId: 'pose.apple-vision',
    modelVersion: 'apple-vision-bodypose-1',
    runtime: 'vision_framework' as const,
    executionTarget: 'on_device' as const,
    artifactHash: null,
  };
  const scorerRef = {
    providerId: 'scorer.sm-v1',
    modelVersion: 'sm-v1',
    runtime: 'deterministic' as const,
    executionTarget: 'on_device' as const,
    artifactHash: null,
  };
  return {
    schemaVersion: ANALYSIS_RECORD_SCHEMA_VERSION,
    id: syntheticUuid(rng),
    captureId,
    createdAtIso,
    engineVersion: 'fusion-1',
    strokeTaxonomyVersion: 'taxonomy-1',
    strokeResolution: {
      kind: 'predicted',
      shotType: analysis.shotType,
      confidence: 0.82,
    },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [
      {
        id: syntheticUuid(rng),
        task: 'pose_estimation',
        model: poseRef,
        inputSchemaVersion: 1,
        outputSchemaVersion: 1,
        startedAtIso: createdAtIso,
        completedAtIso: createdAtIso,
        status: 'succeeded',
        failure: null,
      },
    ],
    provenance: {
      appVersion: '1.0.0',
      pipelineVersion: 'fusion-1',
      providerVersions: [poseRef, scorerRef],
      scoreVersion: 'sm-v1',
      taxonomyVersion: 'taxonomy-1',
      drillMappingVersion: 'drills-1',
      captureEnvelopeVersion: 'envelope-1',
      recordedAtIso: createdAtIso,
    },
    result: analysis,
    faults: [],
    uncertainty: {
      analysisConfidence: analysis.analysisConfidence,
      presentation: analysis.resultKind === 'scored' ? 'normal' : 'abstain',
      perCheckpoint: Object.fromEntries(
        analysis.checkpoints.map(c => [c.key, c.confidence]),
      ),
      limitingFactors: [],
    },
    evidence: [],
    shadow: [],
  };
}
