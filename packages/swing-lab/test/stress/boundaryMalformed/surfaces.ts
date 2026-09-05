/**
 * Input surfaces of @pickle/swing-lab exercised by the boundary/malformed
 * stress lens, each with a VALID base payload (TEST-ONLY fixtures — the
 * identities, ids and evidence refs below exist nowhere outside this
 * harness and are never persisted) and the contract the runner checks.
 *
 * Two surface kinds:
 *  - "validator": takes `unknown` (JSON read from disk) and must return a
 *    problems list — never throw, never write, never mutate its input,
 *    deterministic; unambiguously invalid payloads MUST be rejected.
 *  - "typed": takes a typed record (which the lab CLIs obtain by casting
 *    `JSON.parse(...)` results, so wrong-typed data DOES reach them) and must
 *    either return a well-formed, all-finite result or abstain / throw the
 *    error its contract documents — never a TypeError, never NaN in output.
 */
import type { PoseSequence } from "@pickle/swing-domain";
import type { EvaluationTrialRecord } from "@pickle/shared-types";
import { validateAnnotation } from "../../../src/annotationSchema.js";
import {
  STROKE_GOLD_SCHEMA_VERSION,
  STROKE_GOLD_TAXONOMY_VERSION,
  validateStrokeGoldFile,
} from "../../../src/strokeTaxonomyBench.js";
import {
  COACH_QUALIFICATION_POLICY_VERSION,
  isEligibleReviewer,
  provisioningActionIdFor,
  scaffoldCoachRegistryV2,
  validateCoachQualification,
  validateCoachRegistry,
  validateCoachRegistryEntry,
  validateProvisioningAction,
  type CoachQualification,
  type CoachRegistryEntryV2,
  type ProvisioningAction,
} from "../../../src/coachProvisioning.js";
import type { CoachReview } from "../../../src/coachReview.js";
import {
  detectModelCoachConflicts,
  openInvestigationCase,
  validateInvestigationCase,
  type ModelStrokeAssessment,
} from "../../../src/modelCoachDisagreement.js";
import { BUNDLE_VERSION, parseBundle, sha256Hex } from "../../../src/experimentBundle.js";
import { checkArtifactInvariants } from "../../../src/invariants.js";
import { checkProvenanceChain } from "../../../src/provenanceChain.js";
import { ingestTrials } from "../../../src/freshUserTrials.js";
import { detectTriageSignals } from "../../../src/triageSignals.js";
import { classifyStroke } from "../../../src/strokeHeuristic.js";
import {
  proposeStrokeEvents,
  proposeStrokeEventsV2,
  selectTargetEventV2,
} from "../../../src/strokeEvents.js";
import { segmentPhasesTemporal, segmentPhasesTemporalV2 } from "../../../src/phaseTemporal.js";
import {
  buildPlayerTracks,
  selectTargetPlayer,
  type PeopleFile,
} from "../../../src/playerTracker.js";
import { buildPaddleTracks, type RawPaddleDetectionFile } from "../../../src/paddleTracker.js";
import { pairwiseRankingAgreement, spearman } from "../../../src/coachGates.js";
import {
  areaUnderRiskCoverage,
  calibrationReport,
  coverageRiskCurve,
  reliabilityBins,
  type ConfidenceSample,
} from "../../../src/calibration.js";
import {
  deriveReleaseStatus,
  evaluateGoldAdmission,
  type GoldCandidate,
  type ReleaseEvidenceEvent,
} from "../../../src/goldAdmission.js";
import {
  evaluateCertificationReadiness,
  evaluateHoldout,
  HOLDOUT_ROTATION_POLICY_VERSION,
  type HoldoutEntry,
  type HoldoutLedger,
} from "../../../src/holdoutRotation.js";
import {
  MUTATION_CATEGORIES,
  NO_HINTS,
  type JsonValue,
  type Mutation,
  type MutationCategory,
  type SurfaceShapeHints,
} from "./mutators.js";
import type { Rng } from "./rng.js";

export type SurfaceResult =
  { kind: "rejected"; problems: string[] } | { kind: "accepted"; output: unknown };

export interface Surface {
  name: string;
  kind: "validator" | "typed";
  /** Where malformed data enters this surface in production/lab use. */
  entry: string;
  hints: SurfaceShapeHints;
  categories: readonly MutationCategory[];
  /** Valid base payload; may be randomized from the seed for typed surfaces. */
  base: (rng: Rng) => JsonValue;
  invoke: (payload: unknown) => SurfaceResult;
  /** Thrown errors that ARE the documented contract of the surface. */
  documentedThrow?: (error: unknown) => boolean;
  /** Surface-specific rejection oracle; `undefined` defers to the mutation flags. */
  mustReject?: (mutations: readonly Mutation[]) => boolean | undefined;
  /** Output paths (regex over dotted path) where a non-finite number is documented. */
  allowNonFiniteOutput?: readonly RegExp[];
}

const ISO = "2026-08-29T00:00:00.000Z";

/** Categories that make sense for validators consuming arbitrary JSON. */
const VALIDATOR_CATEGORIES = MUTATION_CATEGORIES;

/** Categories for typed inputs that the lab reads from JSON files by cast. */
const TYPED_FILE_CATEGORIES: readonly MutationCategory[] = [
  "wrong_type",
  "numeric_extreme",
  "empty_container",
  "duplicate_or_reordered",
  "sparse_array",
  "top_level_shape",
  "prototype_pollution",
  "deep_nesting",
  "oversized_string",
  "null_bytes",
];

/** Categories for typed inputs produced in-process (numeric/structural only). */
const TYPED_INPROCESS_CATEGORIES: readonly MutationCategory[] = [
  "numeric_extreme",
  "empty_container",
  "duplicate_or_reordered",
  "sparse_array",
  "wrong_type",
];

function problems(list: string[]): SurfaceResult {
  return list.length > 0
    ? { kind: "rejected", problems: list }
    : { kind: "accepted", output: null };
}

function asJson<T>(value: T): JsonValue {
  return value as unknown as JsonValue;
}

/* ------------------------------------------------------------------------ *
 * Fixtures (TEST-ONLY)
 * ------------------------------------------------------------------------ */

function annotationBase(): JsonValue {
  return {
    schemaVersion: 1,
    captureBundle: "stress-bundle-1",
    annotatorId: "stress_coach_a",
    createdAtIso: ISO,
    revision: 1,
    stroke: "forehand_drive",
    handedness: "right",
    analyzable: true,
    notAnalyzableReason: null,
    phases: {
      preparationStartMs: 100,
      accelerationStartMs: 900,
      contactMs: 1200,
      followThroughEndMs: 1600,
    },
    faults: [{ checkpoint: "contact_position", severity: 2, note: "late" }],
    checkpointScores: { contact_position: 55, follow_through: null },
    overallScore: 62,
    annotatorConfidence: 0.8,
    notes: "",
    history: [],
  };
}

function strokeGoldBase(): JsonValue {
  return {
    schemaVersion: STROKE_GOLD_SCHEMA_VERSION,
    taxonomyVersion: STROKE_GOLD_TAXONOMY_VERSION,
    provenance: "stress-harness fixture (TEST-ONLY, no real labels)",
    note: "synthetic",
    labels: [
      {
        caseId: "stress-case-1",
        eventStartMs: 1000,
        contactMs: 1400,
        eventEndMs: 1900,
        owner: "target",
        l1: "dink",
        l2: "forehand",
        l3: "dink_straight_forehand",
        reasoning: "TEST-ONLY fixture reasoning long enough to be a sentence.",
        annotatorId: "stress-annotator",
        createdAtIso: ISO,
      },
      {
        caseId: "stress-case-2",
        eventStartMs: 200,
        contactMs: null,
        eventEndMs: 700,
        owner: "other",
        l1: "unknown",
        l2: "unknown",
        l3: "unknown",
        reasoning: "TEST-ONLY fixture: unknown stroke, no commitment.",
        annotatorId: "stress-annotator",
        createdAtIso: ISO,
      },
    ],
  };
}

function qualificationFixture(): CoachQualification {
  return {
    policyVersion: COACH_QUALIFICATION_POLICY_VERSION,
    satisfiedCriteria: ["criterion.professional-coaching-history"],
    verdict: "qualified",
    assessedBy: "stress-admin",
    assessedAtIso: ISO,
    certifications: [],
    professionalCoachingHistory: {
      statement: "TEST-ONLY stress fixture claim, not a real coach",
      verification: {
        method: "employer_confirmed",
        verifiedBy: "stress-admin",
        verifiedAtIso: ISO,
        evidenceRef: "stress-evidence-nonexistent",
      },
    },
    competitiveBackground: null,
    affiliation: null,
    yearsCoaching: null,
    specialties: [],
  };
}

function registryEntryFixture(): CoachRegistryEntryV2 {
  return {
    coachId: "stress-coach-a",
    credentialRef: "stress-cred-a",
    status: "active",
    provisionedAtIso: ISO,
    provisionedBy: "stress-admin",
    qualification: qualificationFixture(),
  };
}

function provisioningActionFixture(): ProvisioningAction {
  return {
    schemaVersion: 1,
    actionId: provisioningActionIdFor("stress-coach-a", 1),
    action: "provision",
    coachId: "stress-coach-a",
    performedBy: "stress-admin",
    performedAtIso: ISO,
    reason: "TEST-ONLY stress fixture provisioning action",
    registryEntry: registryEntryFixture(),
  };
}

function coachReviewFixture(coachId: string, item: string, stroke: string): CoachReview {
  return {
    schemaVersion: 3,
    reviewId: `${item}.${coachId}`,
    queueItemId: item,
    coachId,
    coachCredentialRef: "stress-cred",
    eventRef: { caseId: item.replace(/-E\d+$/, ""), eventIndex: 0 },
    strokeTaxonomyVersion: "pickleball-stroke-taxonomy-v3",
    faultTaxonomyVersion: "fault-taxonomy-v0-draft",
    drillLibraryVersion: "drill-library-v0",
    strokeConfirmation: { kind: "confirmed", stroke: stroke as never },
    overallQuality: { scaleId: "technique-quality-5pt-v1", value: 3 },
    phaseEvaluations: [{ phaseId: "contact", assessment: "good", note: "" }],
    primaryFaultId: null,
    faults: [],
    drillSuggestions: [],
    confidence: 0.95,
    cannotEvaluate: null,
    rationale: "stress fixture rationale long enough to pass validation",
    provenance: {
      coachQualificationSnapshot: {
        coachId,
        credentialRef: "stress-cred",
        registryStatus: "active",
        provisionedAtIso: "2026-08-01T00:00:00.000Z",
        provisionedBy: "stress-fixture-admin",
        snapshotAtIso: ISO,
      },
      videoRef: { path: "fixtures/none.mp4", annotatorId: null, annotationRevision: null },
      analysisVersions: {},
      rawLabelsShown: null,
      adjudicationState: "unadjudicated",
    },
    createdAtIso: ISO,
    submittedAtIso: ISO,
  } as CoachReview;
}

function investigationBase(): JsonValue {
  const assessment: ModelStrokeAssessment = {
    queueItemId: "stress-case-1-E1",
    eventRef: { caseId: "stress-case-1", eventIndex: 0 },
    modelVersions: { "stroke-heuristic": "stroke-heuristic-7" },
    strokeV3: "FOREHAND_DRIVE",
    techniqueQuality: null,
    confidence: 0.92,
    generatedAtIso: "2026-08-28T00:00:00.000Z",
  };
  const coach = coachReviewFixture("stress-coach-a", "stress-case-1-E1", "BACKHAND_DRIVE");
  const conflict = detectModelCoachConflicts([assessment], [coach])[0];
  if (!conflict) throw new Error("stress fixture: expected one model/coach conflict");
  return asJson(openInvestigationCase(conflict, ISO));
}

function bundleBase(): JsonValue {
  const files = [
    { path: "wave-c/c14-coach-portal-summary.json", body: '{"ws":"C14"}\n' },
    { path: "EXP-2026-08-28-cascade-waterfall.json", body: '{"root":true}\n' },
    { path: "wave-b/W14-overlap/agreement.json", body: '{"nested":true}\n' },
  ].map((file) => {
    const bytes = Buffer.from(file.body, "utf8");
    return { path: file.path, sha256: sha256Hex(bytes), bytesBase64: bytes.toString("base64") };
  });
  return {
    bundleVersion: BUNDLE_VERSION,
    generatedAtIso: ISO,
    selection: { waves: ["wave-c"], workstreams: [] },
    files,
  };
}

function trialFixture(): EvaluationTrialRecord {
  return {
    schemaVersion: "evaluation-trial-v1",
    trialId: "11111111-1111-4111-8111-111111111111",
    captureId: "stress-cap-1",
    analysisId: "stress-an-1",
    capturedAtIso: ISO,
    recordedAtIso: "2026-08-29T00:00:01.000Z",
    outcomeKind: "scored",
    outcomeReason: null,
    envelopeOverall: "SUPPORTED",
    latencyMs: 900,
    appVersion: "0.1.0",
    engineVersion: "fusion-1",
    modelBundleVersion: "on-device-fusion-1",
    declaredStroke: null,
    claims: {
      targetLock: { status: "not_measured" },
      eventSelection: { status: "presented", startMs: 0, endMs: 900 },
      strokeLabel: { status: "presented", label: "dink", confidence: 0.8 },
      contactMarker: {
        status: "presented",
        estimatedContactMs: 450,
        ballConfirmed: false,
        paddleConfirmed: false,
      },
      phaseRender: { status: "presented", contactMs: 450, followThroughEndMs: 800 },
      resultScore: {
        status: "presented",
        overallScore: 72,
        analysisConfidence: 0.85,
        presentation: "normal",
      },
    },
    limitingFactors: [],
    userFlags: [],
    dims: {
      userPseudonym: "stress-u1",
      sessionId: "stress-s1",
      courtId: "stress-court",
      deviceModel: "iPhone15,2",
      devicePlatform: "ios",
      osVersion: "17.5",
    },
    consent: { scope: "evaluation_telemetry", consentVersion: "evaluation-telemetry-v1" },
  };
}

/** Artifact-shaped document covering every rule family in invariants.ts and
 * provenanceChain.ts: must produce ZERO violations as the base. */
function artifactBase(): JsonValue {
  return {
    version: "stress-artifact-1",
    event: { eventId: "E1", startMs: 1000, endMs: 1900, peakMs: 1400, confidence: 0.7 },
    contact: {
      status: "estimated",
      estimatedContactMs: 1400,
      confidence: 0.6,
      ballConfirmed: false,
      paddleConfirmed: true,
      supportingEvidence: [{ signal: "paddle_speed_peak", timestampMs: 1400, weight: 0.8 }],
      limitingFactors: [],
    },
    phases: {
      version: "phase-temporal-2",
      source: "paddle",
      confidence: 0.55,
      anchorBasis: "contact",
      preparationStartMs: 1000,
      accelerationStartMs: 1200,
      contactMs: 1400,
      followThroughEndMs: 1700,
      recoveryEndMs: 1900,
      relative: {
        preparationStartMs: -400,
        accelerationStartMs: -200,
        followThroughEndMs: 300,
        recoveryEndMs: 500,
      },
    },
    paddle: {
      status: "tracked",
      observationCount: 12,
      timeline: { bridgePointCount: 2 },
      observations: [
        { timestampMs: 1000, detectorScore: 0.9, nearWrist: true, source: "full_frame" },
        { timestampMs: 1033, detectorScore: 0, nearWrist: false, source: "tracked_estimate" },
      ],
    },
    stroke: {
      taxonomyVersion: "v3",
      classifierVersion: "stroke-heuristic-7",
      label: "FOREHAND_DRIVE",
      leaf: "FOREHAND_DRIVE",
      taxonomyDepth: 3,
      confidence: 0.66,
      evidence: ["wrist_forward_of_torso"],
      limitingFactors: [],
    },
    resolution: {
      resolutionBasis: "predicted",
      predictedStroke: "FOREHAND_DRIVE",
      declaredStroke: null,
    },
    producedBy: { providerId: "stress-provider", modelVersion: "stress-1" },
    spans: [
      { key: "preparation", startMs: 1000, endMs: 1200 },
      { key: "acceleration", startMs: 1200, endMs: 1400 },
      { key: "follow_through", startMs: 1400, endMs: 1700 },
    ],
    rows: [
      { key: "predicted_stroke", provenance: "PREDICTED", value: "FOREHAND_DRIVE" },
      { key: "contact_estimate", provenance: "ESTIMATE", value: 1400 },
    ],
  };
}

/* ------------------------------------------------------------------------ *
 * Typed-surface generators (seeded)
 * ------------------------------------------------------------------------ */

function poseSequence(
  rng: Rng,
  options: { frames: number; startMs: number; stepMs: number },
): PoseSequence {
  const frames = Array.from({ length: options.frames }, (_, index) => {
    const t = options.startMs + index * options.stepMs;
    const swing = Math.sin((index / Math.max(1, options.frames)) * Math.PI);
    return {
      frameIndex: index,
      timestampMs: t,
      confidence: 0.9,
      landmarks: [
        { name: "left_shoulder", x: 0.62, y: 0.4, visibility: 0.9 },
        { name: "right_shoulder", x: 0.78, y: 0.4, visibility: 0.9 },
        { name: "left_hip", x: 0.63, y: 0.6, visibility: 0.9 },
        { name: "right_hip", x: 0.77, y: 0.6, visibility: 0.9 },
        { name: "right_elbow", x: 0.82, y: 0.48, visibility: 0.9 },
        { name: "left_elbow", x: 0.61, y: 0.48, visibility: 0.8 },
        {
          name: "right_wrist",
          x: 0.85 + swing * 0.1 * rng.next(),
          y: 0.55 - swing * 0.05,
          visibility: 0.9,
        },
        { name: "left_wrist", x: 0.6, y: 0.55, visibility: 0.8 },
      ],
    };
  });
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image",
    producedBy: { providerId: "stress", modelVersion: "stress-1" },
    video: { width: 1080, height: 1920, fps: 30 },
    frames,
  } as unknown as PoseSequence;
}

function speedSeries(
  rng: Rng,
  options: { startMs: number; count: number; stepMs: number; peakAt: number },
) {
  return Array.from({ length: options.count }, (_, index) => {
    const t = options.startMs + index * options.stepMs;
    const distance = Math.abs(t - options.peakAt) / 250;
    return {
      timestampMs: t,
      value: Math.max(0.05, 1.8 * Math.exp(-distance * distance)) + rng.next() * 0.02,
    };
  });
}

function classifyBase(rng: Rng): JsonValue {
  const contactMs = 2000;
  const frames = rng.int(0, 60);
  return asJson({
    sequence: poseSequence(rng, { frames, startMs: 1500, stepMs: 33 }),
    window: { startMs: 1700, endMs: 2300 },
    contactMs: rng.chance(0.8) ? contactMs : null,
    eventPeakMs: rng.chance(0.5) ? contactMs - 20 : null,
    handedness: rng.pick(["right", "left"]),
    paddle: rng.chance(0.5)
      ? Array.from({ length: rng.int(0, 20) }, (_, index) => ({
          timestampMs: 1700 + index * 33,
          center: { x: 0.8 + rng.next() * 0.1, y: 0.5 },
          confidence: 0.7,
        }))
      : null,
    paddleSpeeds: rng.chance(0.5)
      ? speedSeries(rng, { startMs: 1500, count: rng.int(0, 40), stepMs: 33, peakAt: contactMs })
      : null,
    wristSpeeds: rng.chance(0.7)
      ? speedSeries(rng, { startMs: 1500, count: rng.int(0, 40), stepMs: 33, peakAt: contactMs })
      : null,
  });
}

function eventsBase(rng: Rng): JsonValue {
  const count = rng.int(0, 120);
  return asJson({
    paddleSpeeds: rng.chance(0.5)
      ? speedSeries(rng, { startMs: 0, count, stepMs: 33, peakAt: 1400 })
      : null,
    wristSpeeds: rng.chance(0.8)
      ? speedSeries(rng, { startMs: 0, count, stepMs: 33, peakAt: 1400 })
      : null,
    clipStartMs: 0,
    clipEndMs: rng.pick([0, 1, 4000, 1e6]),
  });
}

function phasesBase(rng: Rng): JsonValue {
  const count = rng.int(0, 80);
  return asJson({
    window: { startMs: 900, endMs: 1900 },
    event: { startMs: 900, endMs: 1900, peakMs: 1400 },
    contactMs: rng.chance(0.7) ? 1400 : null,
    paddleSpeeds: rng.chance(0.5)
      ? speedSeries(rng, { startMs: 600, count, stepMs: 33, peakAt: 1400 })
      : null,
    wristSpeeds: speedSeries(rng, { startMs: 600, count, stepMs: 33, peakAt: 1400 }),
  });
}

function peopleFileBase(rng: Rng): JsonValue {
  const frames = rng.int(0, 40);
  const people = rng.int(0, 3);
  const file: PeopleFile = {
    schemaVersion: 1,
    poseModelVersion: "stress-pose-1",
    video: { w: 1080, h: 1920, fps: 30 },
    frames: Array.from({ length: frames }, (_, index) => ({
      t: index * 33,
      p: Array.from({ length: people }, (_, person) => ({
        c: 0.9,
        l: ["left_shoulder", "right_shoulder", "left_hip", "right_hip", "right_wrist"].map(
          (n, j) => ({
            n,
            x: 0.3 + person * 0.25 + (j % 2) * 0.1 + rng.next() * 0.01,
            y: 0.4 + Math.floor(j / 2) * 0.1,
            v: 0.9,
          }),
        ),
      })),
    })),
  };
  return asJson(file);
}

function paddleFileBase(rng: Rng): JsonValue {
  const frames = rng.int(0, 40);
  const file: RawPaddleDetectionFile = {
    schemaVersion: 1,
    detector: {
      modelId: "stress-detector",
      version: "1",
      license: "test",
      device: "cpu",
      proxyLabels: ["tennis racket"],
      proxyNote: "stress",
      scoreFloor: 0.2,
    },
    video: { path: "stress.mp4", width: 1080, height: 1920, fps: 30, durationMs: frames * 33 },
    window: { startMs: 0, endMs: frames * 33 },
    timing: {
      modelLoadSec: 0,
      framesProcessed: frames,
      inferenceSecTotal: 0,
      inferenceMsPerFrame: 0,
      wallSecTotal: 0,
    },
    frames: Array.from({ length: frames }, (_, index) => ({
      tMs: index * 33,
      detections: rng.chance(0.8)
        ? [
            {
              box: [800 + index * 2, 900, 120, 160] as [number, number, number, number],
              score: 0.6 + rng.next() * 0.3,
              label: "tennis racket",
            },
          ]
        : [],
      extras: [],
    })),
  };
  return asJson(file);
}

function samplesBase(rng: Rng): JsonValue {
  const count = rng.int(0, 60);
  const samples: ConfidenceSample[] = Array.from({ length: count }, () => ({
    confidence: Math.round(rng.next() * 1000) / 1000,
    correct: rng.chance(0.6),
  }));
  return asJson({ samples, nBins: rng.pick([1, 2, 10, 50]) });
}

function rankingBase(rng: Rng): JsonValue {
  const count = rng.int(0, 30);
  return asJson({
    xs: Array.from({ length: count }, () => Math.round(rng.next() * 100) / 10),
    ys: Array.from({ length: count }, () => rng.int(1, 5)),
    minGap: rng.pick([0, 1, 2]),
  });
}

function goldCandidateBase(rng: Rng): JsonValue {
  const source = rng.pick([
    "human_annotator",
    "coach_review",
    "pseudo_label",
    "model_prediction",
  ] as const);
  const candidate: GoldCandidate = {
    candidateId: "stress-candidate-1",
    source,
    requestedTier: rng.pick(["GOLD", "SILVER", "TRAINING_POOL"] as never[]),
    humanId: source === "pseudo_label" || source === "model_prediction" ? null : "stress-human",
    humanArtifactRef:
      source === "pseudo_label" || source === "model_prediction" ? null : "stress-review.json",
    producingModelVersion: source === "model_prediction" ? "stress-model-1" : null,
    pseudoLabelControls:
      source === "pseudo_label"
        ? {
            protocolRef: "stress-protocol",
            humanSpotCheckRef: "stress-spot-check",
            humanSpotCheckFraction: 0.1,
            holdoutDisjointnessRef: "stress-disjoint",
            producingModelVersion: "stress-model-1",
          }
        : null,
  };
  return asJson(candidate);
}

function ledgerBase(rng: Rng): JsonValue {
  const count = rng.int(0, 8);
  const events: ReleaseEvidenceEvent[] = Array.from({ length: count }, (_, index) => ({
    evidenceRef: `stress-evidence-${rng.int(0, 3)}`,
    kind: rng.pick(["positive", "negative"] as const),
    seq: index + 1,
    detail: "stress",
  }));
  return asJson(events);
}

function holdoutLedgerBase(rng: Rng): JsonValue {
  const entries: HoldoutEntry[] = Array.from({ length: rng.int(0, 4) }, (_, index) => ({
    caseId: `stress-holdout-${index}`,
    tier: rng.pick(["DEV", "VALIDATION", "LOCKED_TEST", "SHADOW_HOLDOUT"] as const),
    status: "ACTIVE",
    firstHeldOutAtIso: ISO,
    inspections: [],
    retirement: null,
    notes: "stress",
  }));
  const ledger: HoldoutLedger = {
    schemaVersion: 1,
    policyVersion: HOLDOUT_ROTATION_POLICY_VERSION,
    generatedAtIso: ISO,
    holdouts: entries,
    successors: [],
  };
  return asJson(ledger);
}

/* ------------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------------ */

function documentedContractError(patterns: readonly RegExp[]): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && patterns.some((pattern) => pattern.test(error.message));
}

/** Rejection oracle for the invariant walkers: a non-finite value injected
 * into a field the checker OWNS must surface as a violation. */
function invariantOracle(owned: RegExp): (mutations: readonly Mutation[]) => boolean | undefined {
  return (mutations) => {
    const touched = mutations.filter(
      (mutation) =>
        (mutation.category === "numeric_extreme" &&
          /NaN|Infinity/.test(mutation.variant) &&
          owned.test(mutation.path)) ||
        (mutation.category === "top_level_shape" && false),
    );
    if (touched.length > 0) return true;
    return false;
  };
}

/* ------------------------------------------------------------------------ *
 * Surface catalogue
 * ------------------------------------------------------------------------ */

export const SURFACES: readonly Surface[] = [
  {
    name: "validateAnnotation",
    kind: "validator",
    entry: "annotate.ts / exportDataset.ts read annotation.json from capture bundles",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/^notes$/, /\.note$/, /^notAnalyzableReason$/],
      pathLikePaths: [/^captureBundle$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => annotationBase(),
    invoke: (payload) => problems(validateAnnotation(payload)),
  },
  {
    name: "validateStrokeGoldFile",
    kind: "validator",
    entry: "strokeTaxonomyBench.ts reads datasets/paddle-bench/stroke-gold.json",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/^provenance$/, /^note$/, /reasoning$/],
      schemaVersionPaths: [/^schemaVersion$/, /^taxonomyVersion$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => strokeGoldBase(),
    invoke: (payload) => problems(validateStrokeGoldFile(payload)),
  },
  {
    name: "validateCoachQualification",
    kind: "validator",
    entry: "coachProvisioning.ts — coach registry / provisioning action files",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/statement$/, /^affiliation$/],
      schemaVersionPaths: [/^policyVersion$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => asJson(qualificationFixture()),
    invoke: (payload) => problems(validateCoachQualification(payload)),
  },
  {
    name: "validateCoachRegistryEntry",
    kind: "validator",
    entry: "coachProvisioning.ts — datasets/coach-review registry entries",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/statement$/, /^qualification\.affiliation$/],
      schemaVersionPaths: [/policyVersion$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => asJson(registryEntryFixture()),
    invoke: (payload) => {
      const list = validateCoachRegistryEntry(payload);
      if (list.length > 0) return { kind: "rejected", problems: list };
      // A valid entry must also give a boolean eligibility verdict without throwing.
      return {
        kind: "accepted",
        output: { eligible: isEligibleReviewer(payload as CoachRegistryEntryV2) },
      };
    },
  },
  {
    name: "validateCoachRegistry",
    kind: "validator",
    entry: "coachProvisioning.ts — whole registry document",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/statement$/, /^note$/],
      schemaVersionPaths: [/^schemaVersion$/, /policyVersion$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => asJson({ ...scaffoldCoachRegistryV2(), coaches: [registryEntryFixture()] }),
    invoke: (payload) => problems(validateCoachRegistry(payload)),
  },
  {
    name: "validateProvisioningAction",
    kind: "validator",
    entry: "coachProvisioning.ts — append-only provisioning audit trail",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/^reason$/, /statement$/],
      schemaVersionPaths: [/^schemaVersion$/, /policyVersion$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => asJson(provisioningActionFixture()),
    invoke: (payload) => problems(validateProvisioningAction(payload, {})),
  },
  {
    name: "validateInvestigationCase",
    kind: "validator",
    entry: "modelCoachDisagreement.ts — investigation case store records",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/rationale$/, /note$/, /detail$/],
      schemaVersionPaths: [/^version$/, /Version$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => investigationBase(),
    invoke: (payload) => problems(validateInvestigationCase(payload)),
  },
  {
    name: "parseBundle",
    kind: "validator",
    entry: "experimentBundle.ts — imports a bundle JSON produced on another machine",
    hints: {
      ...NO_HINTS,
      schemaVersionPaths: [/^bundleVersion$/],
      pathLikePaths: [/^files\.\[\]\.path$/],
      opaquePaths: [/bytesBase64$/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => bundleBase(),
    invoke: (payload) => {
      const result = parseBundle(payload);
      if (result.bundle === null) return { kind: "rejected", problems: result.problems };
      return {
        kind: "accepted",
        output: { files: result.bundle.files.length, problems: result.problems },
      };
    },
  },
  {
    name: "checkArtifactInvariants",
    kind: "validator",
    entry:
      "invariants.ts — walks every committed artifact JSON (test/propertyInvariants corpus scan)",
    hints: { ...NO_HINTS, opaquePaths: [/^rows/] },
    categories: VALIDATOR_CATEGORIES,
    base: () => artifactBase(),
    invoke: (payload) =>
      problems(checkArtifactInvariants(payload).map((v) => `${v.rule}@${v.path}`)),
    mustReject: invariantOracle(/confidence|(^|\.)(startMs|endMs)$/i),
  },
  {
    name: "checkProvenanceChain",
    kind: "validator",
    entry: "provenanceChain.ts — walks every committed artifact JSON",
    hints: NO_HINTS,
    categories: VALIDATOR_CATEGORIES,
    base: () => artifactBase(),
    invoke: (payload) => problems(checkProvenanceChain(payload).map((v) => `${v.rule}@${v.path}`)),
    mustReject: invariantOracle(
      /supportingEvidence\.\[\]\.(timestampMs|weight)$|observationCount$|bridgePointCount$/,
    ),
  },
  {
    name: "ingestTrials",
    kind: "validator",
    entry: "freshUserTrials.ts — evaluation telemetry records exported from devices",
    hints: {
      ...NO_HINTS,
      freeTextPaths: [/^outcomeReason$/],
      schemaVersionPaths: [/^schemaVersion$/, /consentVersion$/],
      opaquePaths: [/^dims\./, /^limitingFactors/, /^userFlags/],
    },
    categories: VALIDATOR_CATEGORIES,
    base: () => asJson(trialFixture()),
    invoke: (payload) => {
      const result = ingestTrials([payload]);
      if (result.rejected.length > 0) {
        return { kind: "rejected", problems: result.rejected.map((r) => r.errors.join("; ")) };
      }
      // Accepted records flow straight into the triage detectors.
      const summary = detectTriageSignals(result.accepted);
      return { kind: "accepted", output: summary };
    },
  },
  {
    name: "classifyStroke",
    kind: "typed",
    entry:
      "vision-geometry strokeHeuristicLite via swing-lab analyzeVideo (in-process numeric input)",
    hints: NO_HINTS,
    categories: TYPED_INPROCESS_CATEGORIES,
    base: classifyBase,
    invoke: (payload) => ({
      kind: "accepted",
      output: classifyStroke(payload as Parameters<typeof classifyStroke>[0]),
    }),
  },
  {
    name: "proposeStrokeEvents",
    kind: "typed",
    entry: "strokeEvents.ts — speed series computed from tracker output",
    hints: NO_HINTS,
    categories: TYPED_INPROCESS_CATEGORIES,
    base: eventsBase,
    invoke: (payload) => {
      const input = payload as Parameters<typeof proposeStrokeEvents>[0];
      const v1 = proposeStrokeEvents(input);
      const v2 = proposeStrokeEventsV2(input);
      const selected = selectTargetEventV2(v2.events, 1400);
      return { kind: "accepted", output: { v1, v2, selected } };
    },
  },
  {
    name: "segmentPhasesTemporal",
    kind: "typed",
    entry: "phaseTemporal.ts — event window + speed series",
    hints: NO_HINTS,
    categories: TYPED_INPROCESS_CATEGORIES,
    base: phasesBase,
    invoke: (payload) => {
      const input = payload as {
        window: { startMs: number; endMs: number };
        event: { startMs: number; endMs: number; peakMs?: number };
        contactMs: number | null;
        paddleSpeeds: Array<{ timestampMs: number; value: number }> | null;
        wristSpeeds: Array<{ timestampMs: number; value: number }> | null;
      };
      const v1 = segmentPhasesTemporal(input);
      const v2 = segmentPhasesTemporalV2(input);
      return { kind: "accepted", output: { v1, v2 } };
    },
    // Anchor-free timelines carry contactMs = NaN by contract (⇒ null in JSON).
    allowNonFiniteOutput: [/^v2\.boundaries\.contactMs$/],
  },
  {
    name: "buildPlayerTracks",
    kind: "typed",
    entry: "playerTracker.ts — people.json read by cast from disk",
    hints: NO_HINTS,
    categories: TYPED_FILE_CATEGORIES,
    base: peopleFileBase,
    invoke: (payload) => {
      const tracks = buildPlayerTracks(payload as PeopleFile);
      const selection = selectTargetPlayer(tracks, { policy: "auto" }, { startMs: 0, endMs: 1000 });
      return { kind: "accepted", output: { tracks, selection } };
    },
  },
  {
    name: "buildPaddleTracks",
    kind: "typed",
    entry: "paddleTracker.ts — paddle detections JSON read by cast from disk",
    hints: NO_HINTS,
    categories: TYPED_FILE_CATEGORIES,
    base: paddleFileBase,
    invoke: (payload) => {
      const file = payload as RawPaddleDetectionFile;
      return { kind: "accepted", output: buildPaddleTracks(file, file.window) };
    },
  },
  {
    name: "calibration",
    kind: "typed",
    entry: "calibration.ts — (confidence, correct) samples from per-case artifacts",
    hints: NO_HINTS,
    categories: TYPED_INPROCESS_CATEGORIES,
    base: samplesBase,
    invoke: (payload) => {
      const input = payload as { samples: ConfidenceSample[]; nBins: number };
      return {
        kind: "accepted",
        output: {
          bins: reliabilityBins(input.samples, input.nBins),
          report: calibrationReport(input.samples, { nBins: input.nBins }),
          curve: coverageRiskCurve(input.samples),
          aurc: areaUnderRiskCoverage(input.samples),
        },
      };
    },
    documentedThrow: documentedContractError([
      /^confidence must be a finite number/,
      /^confidence out of \[0,1\]/,
      /^nBins must be a positive integer/,
      /^ECE undefined on empty input/,
    ]),
  },
  {
    name: "coachGatesRanking",
    kind: "typed",
    entry: "coachGates.ts — spearman / pairwiseRankingAgreement over coach quality ratings",
    hints: NO_HINTS,
    categories: TYPED_INPROCESS_CATEGORIES,
    base: rankingBase,
    invoke: (payload) => {
      const input = payload as { xs: number[]; ys: number[]; minGap: number };
      return {
        kind: "accepted",
        output: {
          spearman: spearman(input.xs, input.ys),
          pairwise: pairwiseRankingAgreement(input.xs, input.ys, input.minGap),
        },
      };
    },
  },
  {
    name: "evaluateGoldAdmission",
    kind: "typed",
    entry: "goldAdmission.ts — label-admission gate over candidate records",
    hints: NO_HINTS,
    categories: TYPED_FILE_CATEGORIES,
    base: goldCandidateBase,
    invoke: (payload) => ({
      kind: "accepted",
      output: evaluateGoldAdmission(payload as GoldCandidate),
    }),
  },
  {
    name: "deriveReleaseStatus",
    kind: "typed",
    entry: "goldAdmission.ts — append-only release-evidence ledger fold",
    hints: NO_HINTS,
    categories: TYPED_FILE_CATEGORIES,
    base: ledgerBase,
    invoke: (payload) => ({
      kind: "accepted",
      output: deriveReleaseStatus(payload as readonly ReleaseEvidenceEvent[]),
    }),
    documentedThrow: documentedContractError([/^release ledger seq must be strictly increasing/]),
  },
  {
    name: "evaluateCertificationReadiness",
    kind: "typed",
    entry: "holdoutRotation.ts — holdout ledger JSON read by cast (loadHoldoutLedger)",
    hints: NO_HINTS,
    categories: TYPED_FILE_CATEGORIES,
    base: holdoutLedgerBase,
    invoke: (payload) => {
      const ledger = payload as HoldoutLedger;
      return {
        kind: "accepted",
        output: {
          readiness: evaluateCertificationReadiness(ledger),
          holdouts: ledger.holdouts.map(evaluateHoldout),
        },
      };
    },
    // DEV / VALIDATION inspection budgets are frozen at +Infinity (INSPECTION_BUDGETS).
    allowNonFiniteOutput: [/\.budget$/],
  },
];

export function surfaceByName(name: string): Surface {
  const surface = SURFACES.find((candidate) => candidate.name === name);
  if (!surface) throw new Error(`unknown stress surface ${name}`);
  return surface;
}
