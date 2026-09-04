import { Platform } from 'react-native';
import { ok, type ShotTypeSlug } from '@pickle/shared-types';
import type {
  ProviderDescriptor,
  VisionProviderSet,
} from '@pickle/vision-contracts';
import { SCORING_MODEL_VERSION } from '@pickle/scoring';
import {
  CheckpointThresholdFaultDetector,
  EngineUncertaintyEstimator,
  PriorityCoachingRanker,
  Sm1TechniqueScorer,
} from '@pickle/scoring';
import {
  classifyStroke,
  createGeometryProviderSet,
  GEOMETRY_BUNDLE_VERSION,
  GeometricPhaseSegmenter,
  GeometryBiomechanicsExtractor,
  type HeuristicPaddleObservation,
  type RecordedStrokeInput,
} from '@pickle/vision-geometry';
import {
  DEFAULT_MODEL_MANIFEST,
  ModelRegistry,
  type ModelManifestEntry,
  type Platform as ModelPlatform,
} from '@pickle/model-registry';
import type {
  FusionProviders,
  IHierarchicalStrokeClassifier,
} from '@pickle/analysis-pipeline';
import type { PoseSequence } from '@pickle/swing-domain';

/**
 * Centralized provider composition (directive §5/§61).
 *
 * This is the ONLY place the app maps model-registry entries to concrete
 * implementations. Everything downstream consumes stable contracts; swapping
 * a model is a registry/manifest change plus (for new implementations) one
 * entry in the catalog below — never a change to capture, results, storage,
 * or coaching code.
 *
 * Honesty invariants: providers are only issued for captures with a real
 * recorded pose sequence; absent tasks (paddle, ball, court, classifier)
 * resolve to null and the fusion engine degrades and reports accordingly.
 */

export const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);

function currentPlatform(): ModelPlatform {
  return Platform.OS === 'android' ? 'android' : 'ios';
}

export type ProviderAvailability =
  | { kind: 'real'; providers: VisionProviderSet }
  | { kind: 'unavailable'; reason: string };

/** What this build ships for scoring, reported honestly in Settings. */
export const SCORING_STACK_VERSION = `${SCORING_MODEL_VERSION} · ${GEOMETRY_BUNDLE_VERSION}`;

export interface ScoringStackStatus {
  installed: true;
  version: string;
  /** The capture-side input the stack needs before it can score a clip. */
  requirement: 'recorded_pose_sequence';
}

export function scoringStackStatus(): ScoringStackStatus {
  return {
    installed: true,
    version: SCORING_STACK_VERSION,
    requirement: 'recorded_pose_sequence',
  };
}

/**
 * Hierarchical stroke classifier adapter over the PURE ported heuristic
 * (@pickle/vision-geometry strokeHeuristicLite). This is the AUTO DETECT
 * provider: it commits at most a taxonomy depth-2 side (or OVERHEAD at
 * depth 1) and abstains to UNKNOWN otherwise — the fusion engine's
 * resolution ladder (strokeAutoResolution.ts) does the routing. On declared
 * runs its only power is surfacing disagreement.
 *
 * Honesty note: mobile measures no paddle track or speed series today, so
 * the heuristic reads the dominant wrist at the trigger's motion peak and
 * reports those substitutions in limitingFactors itself.
 */
class HeuristicHierarchicalStrokeClassifier implements IHierarchicalStrokeClassifier {
  public readonly descriptor: ProviderDescriptor;

  public constructor(entry: ModelManifestEntry) {
    this.descriptor = {
      providerId: entry.id,
      modelVersion: entry.version,
      runtime: entry.runtime,
      executionTarget: entry.executionTarget,
      artifactHash: entry.artifactHash,
      inputSchemaVersion: entry.inputSchemaVersion,
      outputSchemaVersion: entry.outputSchemaVersion,
    };
  }

  public async classify(
    input: Parameters<IHierarchicalStrokeClassifier['classify']>[0],
  ): ReturnType<IHierarchicalStrokeClassifier['classify']> {
    // Measured paddle centers only; absent keypoints are dropped, not filled.
    const paddle: HeuristicPaddleObservation[] | null = input.paddle
      ? input.paddle.observations.flatMap(observation =>
          observation.keypoints.center
            ? [
                {
                  timestampMs: observation.timestampMs,
                  center: {
                    x: observation.keypoints.center.x,
                    y: observation.keypoints.center.y,
                  },
                },
              ]
            : [],
        )
      : null;
    return ok(
      classifyStroke({
        sequence: input.pose,
        window: input.window,
        contactMs: input.contactMs,
        eventPeakMs: input.eventPeakMs,
        handedness: input.handedness,
        paddle: paddle && paddle.length > 0 ? paddle : null,
        paddleSpeeds: null, // not measured on mobile — never synthesized
        wristSpeeds: null, // not measured on mobile — never synthesized
      }),
    );
  }
}

/** Recorded pose video dimensions — the one aspect every provider measures with. */
export type RecordedVideoDimensions = Pick<
  PoseSequence['video'],
  'width' | 'height'
>;

/**
 * Aspect ratio of the recorded pose video, derived exactly as
 * GeometryBiomechanicsExtractor derives it so every provider in one fusion
 * set scales normalized landmarks identically.
 */
export function recordedVideoAspectRatio(
  video: RecordedVideoDimensions,
): number {
  return video.height > 0 ? video.width / video.height : 1;
}

/**
 * Fusion provider bundle resolved through the model registry. Returns an
 * honest unavailability when a REQUIRED task has no production entry for
 * this platform/stroke; optional modalities resolve to null.
 *
 * `video` is the recorded pose sequence's frame size. Landmarks are
 * normalized per axis, so distance-based providers need the capture's
 * aspect ratio to measure real geometry; iPhone guided captures are
 * portrait, never square.
 *
 * `shotType` is the DECLARED stroke; null means AUTO DETECT. A declared
 * stroke keeps the per-stroke scorer release gate (a stroke we cannot score
 * is refused up front). With declared=null the target stroke is unknown
 * until the classifier runs, so the per-stroke gate cannot apply here —
 * scoring stays honest because slug-conditioned stages only run when the
 * pipeline resolves a registry leaf, and Sm1's scorer fails typed per-slug
 * at score time for unreleased strokes.
 */
export function createFusionProviders(
  shotType: ShotTypeSlug | null,
  video: RecordedVideoDimensions,
):
  | { kind: 'real'; providers: FusionProviders }
  | { kind: 'unavailable'; reason: string } {
  const platform = currentPlatform();
  const phase = registry.resolve({ task: 'phase_segmentation', platform });
  const biomech = registry.resolve({
    task: 'biomechanics_extraction',
    platform,
  });
  const scorer =
    shotType === null
      ? registry.resolve({ task: 'technique_scoring', platform })
      : registry.resolve({
          task: 'technique_scoring',
          platform,
          stroke: shotType,
        });
  const faults = registry.resolve({ task: 'fault_detection', platform });
  const uncertainty = registry.resolve({
    task: 'uncertainty_estimation',
    platform,
  });
  const coach = registry.resolve({ task: 'coaching_ranking', platform });
  const autoClassifier = registry.resolve({
    task: 'stroke_classification',
    platform,
  });
  if (!phase || !biomech || !faults || !uncertainty || !coach) {
    return {
      kind: 'unavailable',
      reason:
        'A required analysis provider is missing from the model registry.',
    };
  }
  if (!scorer) {
    return {
      kind: 'unavailable',
      reason:
        shotType === null
          ? 'Technique scoring is not registered for this platform. No score will be invented.'
          : `Technique scoring for "${shotType.replace(
              /_/g,
              ' ',
            )}" is not yet released. No score will be invented.`,
    };
  }
  // AUTO DETECT requires the hierarchical classifier — without it a
  // declared-null run has no honest route and is refused before any permit
  // is reserved, instead of failing deep inside the pipeline.
  if (
    shotType === null &&
    (!autoClassifier || autoClassifier.id !== 'stroke.heuristic-hierarchical')
  ) {
    return {
      kind: 'unavailable',
      reason:
        'Auto Detect needs the on-device stroke classifier, which is not registered for this platform. Declare the technique to analyze this capture.',
    };
  }
  // Catalog: registry id → implementation. New models extend this map.
  return {
    kind: 'real',
    providers: {
      phase: new GeometricPhaseSegmenter({
        aspectRatio: recordedVideoAspectRatio(video),
      }),
      biomechanics: new GeometryBiomechanicsExtractor(),
      scorer: new Sm1TechniqueScorer(),
      faultDetector: new CheckpointThresholdFaultDetector(),
      uncertainty: new EngineUncertaintyEstimator(),
      coach: new PriorityCoachingRanker(),
      classifier: null, // No validated FLAT (slug-level) classifier exists yet.
      // Hierarchical classifier: AUTO DETECT route on declared-null runs;
      // disagreement surfacing only on declared runs (never an override).
      autoStrokeClassifier:
        autoClassifier?.id === 'stroke.heuristic-hierarchical'
          ? new HeuristicHierarchicalStrokeClassifier(autoClassifier)
          : null,
      shadowScorers: [], // Populated when a candidate model reaches "shadow".
    },
  };
}

/**
 * Legacy per-clip provider set for the live-session path (analyzeClip).
 * Issued only for captures carrying a real recorded pose sequence.
 */
export function selectVisionProviders(
  shotType: ShotTypeSlug,
  recording?: RecordedStrokeInput | null,
): ProviderAvailability {
  // Shot-specific behavior lives in the scoring config, not in provider code.
  void shotType;
  if (!recording) {
    return {
      kind: 'unavailable',
      reason:
        'This capture has no recorded pose sequence. Scoring runs only on pose frames measured during capture — Pickle Sensei will not generate a score from reconstructed or placeholder motion.',
    };
  }
  if (recording.poseFrames.length < 6) {
    return {
      kind: 'unavailable',
      reason:
        'Too few pose frames were measured during this capture to score it honestly.',
    };
  }
  return { kind: 'real', providers: createGeometryProviderSet(recording) };
}
