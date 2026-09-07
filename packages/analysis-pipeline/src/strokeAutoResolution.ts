import type {
  CameraView,
  EnvelopeVerdict,
  Handedness,
  OperationFailure,
  Result,
  ShotAnalysis,
  ShotTypeSlug,
  TechniqueIntent,
} from "@pickle/shared-types";
import {
  CHECKPOINTS,
  ENVELOPE_DIMENSIONS,
  ENVELOPE_STATUSES,
  FAULT_DIRECTIONS,
  PHASES,
  SHOT_TYPES,
  fail,
  failure,
  ok,
  SELECTABLE_TECHNIQUES_V1,
  SHARED_SIDE_PROFILES_V1,
  TECHNIQUE_ANALYSIS_PROFILES_V1,
  TECHNIQUE_INTENT_VERSION,
  type SharedSideKey,
} from "@pickle/shared-types";
import type {
  AnalysisRecord,
  AnalysisRunProvenance,
  BallTrack,
  EvidenceRef,
  ModelRef,
  ModelRunRecord,
  ModalityAvailability,
  PaddleTrack,
  PoseSequence,
  StrokePrediction as FlatStrokePrediction,
} from "@pickle/swing-domain";
import {
  CAPTURE_ENVELOPE_VERSION_NOT_MEASURED,
  DRILL_MAPPING_VERSION_UNRESOLVED,
  EXECUTION_TARGETS,
  explainAnalysisRun,
  MODEL_RUNTIMES,
  MODEL_TASKS,
} from "@pickle/swing-domain";
import type { ProviderDescriptor } from "@pickle/vision-contracts";

/**
 * AUTO DETECT (declared-null) stroke resolution — D-031 follow-up.
 *
 * TAP / VOICE / AUTO all produce a TechniqueIntent; TAP and VOICE arrive here
 * as a declared ShotTypeSlug, AUTO arrives as declared=null. This module
 * makes declared-null a first-class route: the fusion engine runs the
 * hierarchical stroke classifier and resolves the analysis profile from the
 * PREDICTED stroke — never by inventing one.
 *
 * Resolution ladder (every rung terminates in a shared-types registry):
 *  - leaf commitment (taxonomy leaf, e.g. FOREHAND_DRIVE, or OVERHEAD which
 *    the v3 taxonomy commits as a leaf at depth 1)
 *      → exact TECHNIQUE_ANALYSIS_PROFILES_V1 profile, basis "predicted_l3",
 *        and the leaf's legacy slug drives the existing scoring chain;
 *  - depth-2 side commitment (FOREHAND / BACKHAND)
 *      → SHARED_SIDE_PROFILES_V1 shared profile, basis "predicted_family".
 *        The run retains family evidence and requires explicit technique
 *        confirmation instead of scoring against a representative drive;
 *        no leaf technique is ever claimed;
 *  - UNKNOWN or below the confidence floor
 *      → basis "abstained": a durable record of what the classifier said,
 *        with no invented stroke and no score.
 *
 * declared and predicted stay separate everywhere: a declaration NARROWS the
 * interpretation (selects the profile) but never forces the prediction, and
 * a prediction never silently overwrites a declaration.
 */

/**
 * CONFIDENCE GATE — read this before changing the numbers.
 *
 * The producing classifier today is the canonical stroke heuristic
 * (`classifyStroke` in @pickle/vision-geometry; version string
 * STROKE_HEURISTIC_VERSION): measured geometry, NOT a learned or calibrated model.
 * Its confidences are ordinal bookkeeping, not probabilities:
 *  - UNKNOWN is emitted at a fixed 0.2;
 *  - a depth-2 side commitment is 0.45 + 0.5·margin, clamped to [0.45, 0.8],
 *    and the heuristic itself refuses to commit below a 0.15 shoulder-width
 *    margin — so every committed side arrives at ≥ 0.525;
 *  - OVERHEAD (depth-1 leaf) is 0.5 + lift/2, clamped to [0.5, 0.85].
 *
 * Because those numbers are uncalibrated, the PRIMARY gate is structural:
 * the label/leaf/depth the classifier was willing to commit to (it already
 * embeds its own evidence margins), plus UNKNOWN as an explicit abstention.
 * The numeric floor below is a conservative backstop, set at 0.5: strictly
 * above the heuristic's fixed UNKNOWN confidence and at/below every
 * commitment it can emit, so it never second-guesses today's structural
 * gate but rejects any future provider that reports a commitment while
 * signalling sub-coin-flip confidence. Do NOT raise this floor to "tune"
 * auto-detect precision without calibration data, and do NOT lower it.
 *
 * Depth-3 commitments (DINK vs DRIVE vs VOLLEY…) do not exist today —
 * bounce is unobserved and the stroke heuristic refuses L3. The predicted_l3
 * route is exercised only when a classifier genuinely commits a leaf; this
 * module must never promote a depth-2 prediction to a leaf.
 */
export const AUTO_RESOLUTION_MIN_CONFIDENCE = 0.5;

/** How the analysis profile was chosen for this run. */
export type StrokeResolutionBasis = "declared" | "predicted_l3" | "predicted_family" | "abstained";

/**
 * Hierarchical stroke prediction — structurally compatible with the output
 * of the stroke heuristic's `classifyStroke`, so an adapter can
 * pass it through unchanged. Kept separate from swing-domain's flat
 * StrokePrediction: hierarchy depth is the honesty mechanism here.
 */
export interface HierarchicalStrokePrediction {
  taxonomyVersion: string;
  classifierVersion: string;
  /** Deepest label the evidence supports (may be coarse, e.g. "FOREHAND"). */
  label: string;
  /** Committed taxonomy leaf (e.g. "FOREHAND_DRIVE", "OVERHEAD") or null. */
  leaf: string | null;
  taxonomyDepth: 1 | 2 | 3;
  /** Heuristic / uncalibrated — see the gate note above. */
  confidence: number;
  evidence: string[];
  limitingFactors: string[];
}

/**
 * Hierarchical classifier provider contract. Defined here (not in
 * vision-contracts) because the fusion engine is its only consumer today;
 * it can be promoted to vision-contracts unchanged when a second consumer
 * appears. Inputs are exactly what the fusion engine measures before phase
 * segmentation: the canonical pose sequence, optional paddle/ball tracks,
 * and the trigger window (event peak stands in for contact when contact was
 * not measured — the classifier reports that substitution itself).
 */
export interface IHierarchicalStrokeClassifier {
  readonly descriptor: ProviderDescriptor;
  classify(input: {
    pose: PoseSequence;
    paddle: PaddleTrack | null;
    ball: BallTrack | null;
    window: { startMs: number; endMs: number };
    contactMs: number | null;
    eventPeakMs: number | null;
    handedness: Handedness;
  }): Promise<Result<HierarchicalStrokePrediction>>;
}

/** Declared-vs-predicted disagreement, surfaced but never resolved silently. */
export interface StrokeDisagreement {
  declared: ShotTypeSlug;
  predictedLabel: string;
  /** What kind of evidence contradicts the declaration. */
  basis: "leaf_vs_declared" | "side_vs_declared" | "slug_vs_declared";
}

/**
 * The stroke-intent envelope every capture analysis now carries.
 * declaredStroke (null for AUTO) and predictedStroke are separate fields by
 * hard rule; resolvedProfileId is a registry id (leaf canonical or shared
 * side profile id) or null when abstained / not derivable without guessing.
 */
export interface StrokeIntentEnvelope {
  declaredStroke: ShotTypeSlug | null;
  /** Output of the hierarchical classifier when it ran; else null. */
  predictedStroke: HierarchicalStrokePrediction | null;
  resolutionBasis: StrokeResolutionBasis;
  resolvedProfileId: string | null;
  resolvedProfileVersion: string | null;
  disagreement: StrokeDisagreement | null;
  flatPrediction?: FlatStrokePrediction | null;
  confirmation?: TechniqueConfirmationEvidence;
}

export type TechniqueConfirmationReason =
  | "family_only"
  | "ambiguous_technique"
  | "unsupported_technique"
  | "unvalidated_prediction"
  | "unresolved_technique";

export const ANALYSIS_INPUT_SELECTION_VERSION = "capture-analysis-input-v1" as const;

export interface ConfirmationPoint {
  readonly x: number;
  readonly y: number;
}

export interface ConfirmationTargetSelection {
  readonly point: ConfirmationPoint;
  readonly selectedAtIso: string;
}

export interface GuidedConfirmationSelection {
  readonly point: ConfirmationPoint;
  readonly selectedAtIso: string | null;
  readonly source: "guided_start_region";
}

export interface AnalysisInputSelectionSnapshot {
  readonly version: typeof ANALYSIS_INPUT_SELECTION_VERSION;
  readonly ownerKey: string;
  readonly ownerGeneration: number;
  readonly apiOrigin: string;
  readonly captureId: string;
  readonly observationHash: string;
  readonly definitionHash: string;
  readonly modelPolicyHash: string;
  readonly capture: {
    readonly captureMode: "automatic_pose_trigger" | "imported_video";
    readonly capturedAtIso: string;
    readonly durationMs: number;
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly poseFrameCount: number;
    readonly poseModelVersion: string;
    readonly poseUri: string;
    readonly payloadHash: string;
  };
  readonly trigger: {
    readonly startMs: number;
    readonly endMs: number;
    readonly peakMotionMs: number | null;
    readonly confidence: number;
    readonly modelVersion: string;
  };
  readonly declaredStroke: ShotTypeSlug | null;
  readonly declaredCanonical: string | null;
  readonly handedness: Handedness;
  readonly cameraView: CameraView;
  readonly focusCheckpoint: string | null;
  readonly target: {
    readonly userSelection:
      (ConfirmationTargetSelection & { readonly source: "import_tap" }) | null;
    readonly guidedStartTap: GuidedConfirmationSelection | null;
    readonly acquiredAnchor: {
      readonly point: ConfirmationPoint;
      readonly source: string | null;
    } | null;
  };
}

export interface TechniqueConfirmationInput {
  analysisId: string;
  intent: TechniqueIntent;
  confirmedAtIso: string;
}

export interface TechniqueConfirmationEvidence extends TechniqueConfirmationInput {
  originalStrokeIntent: Omit<StrokeIntentEnvelope, "confirmation">;
}

export function isDeclaredTechniqueIntent(
  intent: TechniqueIntent | null | undefined,
): intent is TechniqueIntent & {
  canonical: string;
  legacySlug: ShotTypeSlug;
  source: "tap" | "voice";
} {
  return declaredIntent(intent);
}

/** AnalysisRecord + the stroke-intent envelope (additive, non-breaking). */
interface CaptureAnalysisRecordBase extends AnalysisRecord {
  strokeIntent: StrokeIntentEnvelope;
  /**
   * Capture-envelope verdict measured for this attempt (additive,
   * non-breaking: records written before this field exist without it).
   * Downstream Result surfaces read it to explain quality-related
   * abstentions; it never alters usable-result semantics.
   */
  captureEnvelope?: EnvelopeVerdict | null;
  observationHash?: string;
  inputSelection?: AnalysisInputSelectionSnapshot;
}

export interface NeedsTechniqueConfirmationRecord extends CaptureAnalysisRecordBase {
  kind: "needs_technique_confirmation";
  confirmationReason: TechniqueConfirmationReason;
  result: null;
}

export type CaptureAnalysisRecord =
  | (CaptureAnalysisRecordBase & { kind?: "analyzed"; confirmationReason?: never })
  | NeedsTechniqueConfirmationRecord;

export interface VerifiedTechniqueConfirmationRecord extends NeedsTechniqueConfirmationRecord {
  observationHash: string;
  captureEnvelope: EnvelopeVerdict | null;
  inputSelection: AnalysisInputSelectionSnapshot;
}

/** Outcome of resolving the analysis profile from a prediction. */
export type PredictedProfileResolution =
  | {
      kind: "leaf";
      canonical: string;
      legacySlug: ShotTypeSlug;
      profileId: string;
      profileVersion: string;
    }
  | { kind: "side"; side: SharedSideKey; profileId: string; profileVersion: string }
  | { kind: "abstain"; reason: string };

/**
 * Registry-terminated profile resolution from a hierarchical prediction.
 * A leaf is honored only if it exists in SELECTABLE_TECHNIQUES_V1 with a
 * legacy slug; a side only if it exists in SHARED_SIDE_PROFILES_V1. Any
 * label the registries do not know is an abstention, never a route.
 */
export function resolvePredictedProfile(
  prediction: HierarchicalStrokePrediction,
): PredictedProfileResolution {
  if (prediction.label === "UNKNOWN" || prediction.leaf === "UNKNOWN") {
    return { kind: "abstain", reason: "auto_stroke_prediction_unknown" };
  }
  if (!Number.isFinite(prediction.confidence) || prediction.confidence > 1) {
    return { kind: "abstain", reason: "auto_stroke_confidence_invalid" };
  }
  if (prediction.confidence < AUTO_RESOLUTION_MIN_CONFIDENCE) {
    return { kind: "abstain", reason: "auto_stroke_confidence_below_floor" };
  }
  if (prediction.leaf !== null) {
    if (
      prediction.label !== prediction.leaf ||
      prediction.taxonomyDepth !== (prediction.leaf === "OVERHEAD" ? 1 : 3)
    ) {
      return { kind: "abstain", reason: "auto_stroke_leaf_hierarchy_invalid" };
    }
    const technique = SELECTABLE_TECHNIQUES_V1.find((entry) => entry.canonical === prediction.leaf);
    if (!technique || technique.legacySlug === null) {
      // A leaf the registry does not support cannot become a route.
      return { kind: "abstain", reason: "auto_stroke_leaf_not_in_registry" };
    }
    const profile = TECHNIQUE_ANALYSIS_PROFILES_V1[technique.canonical]!;
    return {
      kind: "leaf",
      canonical: technique.canonical,
      legacySlug: technique.legacySlug,
      profileId: profile.canonical,
      profileVersion: profile.profileVersion,
    };
  }
  if (
    prediction.taxonomyDepth === 2 &&
    (prediction.label === "FOREHAND" || prediction.label === "BACKHAND")
  ) {
    const profile = SHARED_SIDE_PROFILES_V1[prediction.label];
    return {
      kind: "side",
      side: prediction.label,
      profileId: profile.id,
      profileVersion: profile.profileVersion,
    };
  }
  return { kind: "abstain", reason: "auto_stroke_label_not_resolvable" };
}

/** Canonicals whose legacy slug matches a declared slug (registry-derived). */
export function canonicalsForSlug(slug: ShotTypeSlug): string[] {
  return SELECTABLE_TECHNIQUES_V1.filter((entry) => entry.legacySlug === slug).map(
    (entry) => entry.canonical,
  );
}

/**
 * Profile id for a slug-level identity (a DECLARED run, or the legacy flat
 * classifier winning). Several canonicals can share one slug (dink ⊇
 * {FOREHAND_DINK, BACKHAND_DINK, RESET}). When the caller supplied the
 * canonical intent it is honored after validation against the registry;
 * otherwise the slug resolves only if it is unambiguous. Ambiguity yields
 * null — a side is never guessed.
 */
export function resolveSlugProfileId(
  slug: ShotTypeSlug,
  preferredCanonical?: string | null,
): { profileId: string | null; profileVersion: string | null } {
  if (preferredCanonical) {
    const technique = SELECTABLE_TECHNIQUES_V1.find(
      (entry) => entry.canonical === preferredCanonical && entry.legacySlug === slug,
    );
    if (technique) {
      const profile = TECHNIQUE_ANALYSIS_PROFILES_V1[technique.canonical]!;
      return { profileId: profile.canonical, profileVersion: profile.profileVersion };
    }
    // A canonical that does not match the registry (or contradicts the slug)
    // is ignored, not trusted — it cannot become a route.
    return { profileId: null, profileVersion: null };
  }
  const candidates = canonicalsForSlug(slug);
  if (candidates.length === 1) {
    const profile = TECHNIQUE_ANALYSIS_PROFILES_V1[candidates[0]!]!;
    return { profileId: profile.canonical, profileVersion: profile.profileVersion };
  }
  return { profileId: null, profileVersion: null };
}

/**
 * Drill mapping version carried by a resolved profile (leaf or shared side),
 * registry-terminated. A null or unknown profile id yields the unresolved
 * sentinel — a drill mapping is never guessed for a profile that did not
 * resolve.
 */
export function drillMappingVersionForProfile(profileId: string | null): string {
  if (profileId === null) return DRILL_MAPPING_VERSION_UNRESOLVED;
  const leaf = TECHNIQUE_ANALYSIS_PROFILES_V1[profileId];
  if (leaf) return leaf.drillMappingVersion;
  const side = Object.values(SHARED_SIDE_PROFILES_V1).find((profile) => profile.id === profileId);
  return side ? side.drillMappingVersion : DRILL_MAPPING_VERSION_UNRESOLVED;
}

const SIDE_PREFIXES = ["FOREHAND_", "BACKHAND_"] as const;

/**
 * Declared-vs-predicted disagreement from the HIERARCHICAL prediction.
 * Conservative by construction — a disagreement is claimed only when it is
 * structurally demonstrable at the prediction's own depth:
 *  - a committed leaf outside the declared slug's canonical set;
 *  - a committed side when EVERY canonical of the declared slug carries an
 *    explicit side prefix and none matches (a side prediction cannot
 *    contradict a side-agnostic declaration like SERVE or RESET).
 * UNKNOWN or below-floor predictions claim nothing.
 */
export function detectHierarchicalDisagreement(
  declared: ShotTypeSlug,
  prediction: HierarchicalStrokePrediction,
  declaredCanonical?: string | null,
): StrokeDisagreement | null {
  if (resolvePredictedProfile(prediction).kind === "abstain") return null;
  const canonical = declaredCanonical
    ? resolveSlugProfileId(declared, declaredCanonical).profileId
    : null;
  const declaredSet = canonical ? [canonical] : canonicalsForSlug(declared);
  if (declaredSet.length === 0) return null;

  if (prediction.leaf !== null) {
    return declaredSet.includes(prediction.leaf)
      ? null
      : { declared, predictedLabel: prediction.leaf, basis: "leaf_vs_declared" };
  }
  if (
    prediction.taxonomyDepth === 2 &&
    (prediction.label === "FOREHAND" || prediction.label === "BACKHAND")
  ) {
    const allSided = declaredSet.every((canonical) =>
      SIDE_PREFIXES.some((prefix) => canonical.startsWith(prefix)),
    );
    const anyMatches = declaredSet.some((canonical) =>
      canonical.startsWith(`${prediction.label}_`),
    );
    if (allSided && !anyMatches) {
      return { declared, predictedLabel: prediction.label, basis: "side_vs_declared" };
    }
  }
  return null;
}

/**
 * Declared-vs-predicted disagreement from the FLAT (slug-level) classifier,
 * used when no hierarchical prediction exists. Same conservative floor.
 */
export function detectFlatDisagreement(
  declared: ShotTypeSlug,
  prediction: FlatStrokePrediction | null,
): StrokeDisagreement | null {
  if (!prediction || prediction.shotType === "unknown") return null;
  if (
    !Number.isFinite(prediction.confidence) ||
    prediction.confidence > 1 ||
    prediction.confidence < AUTO_RESOLUTION_MIN_CONFIDENCE
  )
    return null;
  if (prediction.shotType === declared) return null;
  return { declared, predictedLabel: prediction.shotType, basis: "slug_vs_declared" };
}

const CONFIRMATION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONFIRMATION_HASH = /^[a-f0-9]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(text);
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some((entry) => entry === value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unit(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function natural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && CONFIRMATION_UUID.test(value);
}

function hash(value: unknown): value is string {
  return typeof value === "string" && CONFIRMATION_HASH.test(value);
}

export function isConfirmationTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const zone = parts[7]!;
  return (
    year > 0 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1]! &&
    Number(parts[4]) < 24 &&
    Number(parts[5]) < 60 &&
    Number(parts[6]) < 60 &&
    (zone === "Z" || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4, 6)) < 60))
  );
}

export function isConfirmationPoint(value: unknown): value is ConfirmationPoint {
  return object(value) && unit(value.x) && unit(value.y);
}

export function isConfirmationTargetSelection(
  value: unknown,
): value is ConfirmationTargetSelection {
  return (
    object(value) &&
    isConfirmationPoint(value.point) &&
    isConfirmationTimestamp(value.selectedAtIso)
  );
}

function modelRef(value: unknown): value is ModelRef {
  return (
    object(value) &&
    text(value.providerId) &&
    text(value.modelVersion) &&
    member(value.runtime, MODEL_RUNTIMES) &&
    member(value.executionTarget, EXECUTION_TARGETS) &&
    (value.artifactHash === null || hash(value.artifactHash))
  );
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return (
    a.providerId === b.providerId &&
    a.modelVersion === b.modelVersion &&
    a.runtime === b.runtime &&
    a.executionTarget === b.executionTarget &&
    a.artifactHash === b.artifactHash
  );
}

function operationFailure(value: unknown): value is OperationFailure {
  return (
    object(value) &&
    member(value.kind, [
      "timeout",
      "retryable",
      "permanent",
      "low_confidence",
      "permission_denied",
      "network",
      "unsupported_device",
      "corrupted_media",
      "auth_failed",
      "not_implemented",
    ]) &&
    text(value.code) &&
    text(value.message) &&
    typeof value.retryable === "boolean" &&
    value.retryable === ["timeout", "retryable", "network"].includes(value.kind)
  );
}

function modelRun(value: unknown): value is ModelRunRecord {
  return (
    object(value) &&
    uuid(value.id) &&
    member(value.task, MODEL_TASKS) &&
    modelRef(value.model) &&
    natural(value.inputSchemaVersion) &&
    value.inputSchemaVersion > 0 &&
    natural(value.outputSchemaVersion) &&
    value.outputSchemaVersion > 0 &&
    isConfirmationTimestamp(value.startedAtIso) &&
    isConfirmationTimestamp(value.completedAtIso) &&
    Date.parse(value.startedAtIso) <= Date.parse(value.completedAtIso) &&
    member(value.status, ["succeeded", "failed", "abstained"]) &&
    (value.status === "succeeded"
      ? value.failure === null
      : operationFailure(value.failure) &&
        (value.status === "abstained") === (value.failure.kind === "low_confidence"))
  );
}

function prediction(value: unknown): value is HierarchicalStrokePrediction {
  return (
    object(value) &&
    text(value.taxonomyVersion) &&
    text(value.classifierVersion) &&
    text(value.label) &&
    (value.leaf === null || text(value.leaf)) &&
    [1, 2, 3].includes(Number(value.taxonomyDepth)) &&
    typeof value.taxonomyDepth === "number" &&
    unit(value.confidence) &&
    strings(value.evidence) &&
    strings(value.limitingFactors)
  );
}

function flatPrediction(value: unknown): value is FlatStrokePrediction {
  return (
    object(value) &&
    member(value.shotType, [...SHOT_TYPES, "unknown"]) &&
    unit(value.confidence) &&
    modelRef(value.producedBy) &&
    Array.isArray(value.alternatives) &&
    value.alternatives.every(
      (entry: unknown) =>
        object(entry) && member(entry.shotType, SHOT_TYPES) && unit(entry.confidence),
    )
  );
}

export function isStrokeIntentEnvelope(
  value: unknown,
  allowConfirmation = true,
): value is StrokeIntentEnvelope {
  if (
    !object(value) ||
    !(value.declaredStroke === null || member(value.declaredStroke, SHOT_TYPES)) ||
    !(value.predictedStroke === null || prediction(value.predictedStroke)) ||
    !member(value.resolutionBasis, ["declared", "predicted_l3", "predicted_family", "abstained"]) ||
    !(value.resolvedProfileId === null || text(value.resolvedProfileId)) ||
    !(value.resolvedProfileVersion === null || text(value.resolvedProfileVersion)) ||
    (value.resolvedProfileId === null) !== (value.resolvedProfileVersion === null) ||
    !(
      value.flatPrediction === undefined ||
      value.flatPrediction === null ||
      flatPrediction(value.flatPrediction)
    )
  )
    return false;
  if (value.disagreement !== null) {
    const disagreement = value.disagreement;
    if (
      !object(disagreement) ||
      value.declaredStroke === null ||
      disagreement.declared !== value.declaredStroke ||
      !text(disagreement.predictedLabel) ||
      !member(disagreement.basis, ["leaf_vs_declared", "side_vs_declared", "slug_vs_declared"])
    )
      return false;
    if (disagreement.basis === "slug_vs_declared") {
      if (!value.flatPrediction || disagreement.predictedLabel !== value.flatPrediction.shotType)
        return false;
    } else if (
      !value.predictedStroke ||
      disagreement.predictedLabel !== value.predictedStroke.label
    )
      return false;
  }
  if ((value.resolutionBasis === "declared") !== (value.declaredStroke !== null)) return false;
  if (value.resolutionBasis === "abstained" && value.resolvedProfileId !== null) return false;
  if (value.resolutionBasis === "predicted_family") {
    if (!value.predictedStroke) return false;
    const resolved = resolvePredictedProfile(value.predictedStroke);
    if (
      resolved.kind !== "side" ||
      value.resolvedProfileId !== resolved.profileId ||
      value.resolvedProfileVersion !== resolved.profileVersion
    )
      return false;
  }
  if (value.resolutionBasis === "predicted_l3" && !value.predictedStroke && !value.flatPrediction)
    return false;
  if (value.confirmation !== undefined) {
    if (
      !allowConfirmation ||
      !object(value.confirmation) ||
      !uuid(value.confirmation.analysisId) ||
      !isConfirmationTimestamp(value.confirmation.confirmedAtIso) ||
      !declaredIntent(value.confirmation.intent) ||
      !isStrokeIntentEnvelope(value.confirmation.originalStrokeIntent, false) ||
      value.confirmation.intent.legacySlug !== value.declaredStroke ||
      value.confirmation.intent.canonical !== value.resolvedProfileId
    )
      return false;
  }
  return true;
}

function declaredIntent(value: unknown): value is TechniqueIntent {
  return (
    object(value) &&
    member(value.source, ["tap", "voice"]) &&
    value.version === TECHNIQUE_INTENT_VERSION &&
    text(value.canonical) &&
    member(value.legacySlug, SHOT_TYPES) &&
    (value.confidence === null || unit(value.confidence)) &&
    (value.rawUserText === undefined || typeof value.rawUserText === "string") &&
    SELECTABLE_TECHNIQUES_V1.some(
      (entry) => entry.canonical === value.canonical && entry.legacySlug === value.legacySlug,
    )
  );
}

function evidenceRef(value: unknown): value is EvidenceRef {
  return (
    object(value) &&
    text(value.claim) &&
    text(value.producedByProviderId) &&
    unit(value.confidence) &&
    strings(value.metricKeys) &&
    (value.window === null ||
      (object(value.window) &&
        finite(value.window.startMs) &&
        value.window.startMs >= 0 &&
        finite(value.window.endMs) &&
        value.window.endMs >= value.window.startMs))
  );
}

function modalities(value: unknown): value is ModalityAvailability {
  return (
    object(value) &&
    value.pose === true &&
    typeof value.paddle === "boolean" &&
    typeof value.ball === "boolean" &&
    typeof value.court === "boolean" &&
    typeof value.camera === "boolean"
  );
}

function predictionHasProducer(
  intent: StrokeIntentEnvelope,
  runs: ModelRunRecord[],
  trace: AnalysisRunProvenance,
): boolean {
  const predicted = intent.predictedStroke;
  const flat = intent.flatPrediction;
  return (
    (!predicted ||
      runs.some(
        (run) =>
          run.task === "stroke_classification" &&
          run.status === "succeeded" &&
          (predicted.classifierVersion === run.model.modelVersion ||
            // The shipping heuristic deliberately labels its output uncalibrated;
            // that documented suffix is not another model or numerical approval.
            (run.model.providerId === "stroke.heuristic-hierarchical" &&
              predicted.classifierVersion === `${run.model.modelVersion} (uncalibrated)` &&
              predicted.taxonomyVersion === "pickleball-stroke-taxonomy-v3")),
      )) &&
    (!flat || trace.providerVersions.some((model) => sameModel(model, flat.producedBy)))
  );
}

function provenance(value: unknown): value is AnalysisRunProvenance {
  return (
    object(value) &&
    [
      "appVersion",
      "pipelineVersion",
      "scoreVersion",
      "taxonomyVersion",
      "drillMappingVersion",
      "captureEnvelopeVersion",
    ].every((key) => text(value[key])) &&
    isConfirmationTimestamp(value.recordedAtIso) &&
    Array.isArray(value.providerVersions) &&
    value.providerVersions.length > 0 &&
    value.providerVersions.every(modelRef)
  );
}

function envelope(value: unknown): value is EnvelopeVerdict | null {
  if (value === null) return true;
  if (
    !object(value) ||
    !text(value.thresholdsVersion) ||
    typeof value.provisional !== "boolean" ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.length !== ENVELOPE_DIMENSIONS.length ||
    !Array.isArray(value.notMeasured)
  )
    return false;
  const seen = new Set<string>();
  const notMeasured = new Set<string>();
  let overall: EnvelopeVerdict["overall"] = "SUPPORTED";
  for (const dimension of value.dimensions) {
    if (
      !object(dimension) ||
      !member(dimension.dimension, ENVELOPE_DIMENSIONS) ||
      seen.has(dimension.dimension) ||
      !member(dimension.status, ENVELOPE_STATUSES) ||
      !text(dimension.unit) ||
      !text(dimension.thresholdId) ||
      (dimension.status === "NOT_MEASURED"
        ? dimension.measured !== null
        : !finite(dimension.measured))
    )
      return false;
    seen.add(dimension.dimension);
    if (dimension.status === "NOT_MEASURED") notMeasured.add(dimension.dimension);
    if (dimension.status === "UNSUPPORTED") overall = "UNSUPPORTED";
    else if (dimension.status === "DEGRADED" && overall !== "UNSUPPORTED") overall = "DEGRADED";
  }
  return (
    value.overall === overall &&
    value.overallWithCoverage ===
      (overall === "SUPPORTED" && notMeasured.size > 0 ? "SUPPORTED_UNMEASURED" : overall) &&
    value.notMeasured.length === notMeasured.size &&
    new Set(value.notMeasured).size === notMeasured.size &&
    value.notMeasured.every(
      (dimension) => typeof dimension === "string" && notMeasured.has(dimension),
    )
  );
}

function apiOrigin(value: unknown): value is string {
  if (!text(value) || /[?#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      url.href.replace(/\/+$/, "") === value
    );
  } catch {
    return false;
  }
}

export function isAnalysisInputSelectionSnapshot(
  value: unknown,
): value is AnalysisInputSelectionSnapshot {
  if (
    !object(value) ||
    value.version !== ANALYSIS_INPUT_SELECTION_VERSION ||
    !uuid(value.ownerKey) ||
    !natural(value.ownerGeneration) ||
    !apiOrigin(value.apiOrigin) ||
    !uuid(value.captureId) ||
    !hash(value.observationHash) ||
    !hash(value.definitionHash) ||
    !hash(value.modelPolicyHash) ||
    !member(value.handedness, ["right", "left", "ambidextrous"]) ||
    !member(value.cameraView, ["side", "rear_oblique"]) ||
    !(value.focusCheckpoint === null || text(value.focusCheckpoint)) ||
    !(value.declaredStroke === null || member(value.declaredStroke, SHOT_TYPES)) ||
    !(value.declaredCanonical === null || text(value.declaredCanonical)) ||
    (value.declaredStroke === null && value.declaredCanonical !== null)
  )
    return false;
  const capture = value.capture;
  const trigger = value.trigger;
  const target = value.target;
  if (
    !object(capture) ||
    !member(capture.captureMode, ["automatic_pose_trigger", "imported_video"]) ||
    !isConfirmationTimestamp(capture.capturedAtIso) ||
    !finite(capture.durationMs) ||
    capture.durationMs <= 0 ||
    !natural(capture.width) ||
    capture.width === 0 ||
    !natural(capture.height) ||
    capture.height === 0 ||
    !finite(capture.fps) ||
    capture.fps <= 0 ||
    !natural(capture.poseFrameCount) ||
    capture.poseFrameCount === 0 ||
    !text(capture.poseModelVersion) ||
    !text(capture.poseUri) ||
    !capture.poseUri.startsWith("file:///") ||
    !hash(capture.payloadHash) ||
    !object(trigger) ||
    !finite(trigger.startMs) ||
    trigger.startMs < 0 ||
    !finite(trigger.endMs) ||
    trigger.endMs <= trigger.startMs ||
    trigger.endMs > capture.durationMs ||
    !(
      trigger.peakMotionMs === null ||
      (finite(trigger.peakMotionMs) &&
        trigger.peakMotionMs >= trigger.startMs &&
        trigger.peakMotionMs <= trigger.endMs)
    ) ||
    !unit(trigger.confidence) ||
    !text(trigger.modelVersion) ||
    !object(target)
  )
    return false;
  if (
    target.userSelection !== null &&
    (!isConfirmationTargetSelection(target.userSelection) ||
      !object(target.userSelection) ||
      target.userSelection.source !== "import_tap" ||
      capture.captureMode !== "imported_video")
  )
    return false;
  if (
    target.guidedStartTap !== null &&
    (!object(target.guidedStartTap) ||
      target.guidedStartTap.source !== "guided_start_region" ||
      !isConfirmationPoint(target.guidedStartTap.point) ||
      !(
        target.guidedStartTap.selectedAtIso === null ||
        isConfirmationTimestamp(target.guidedStartTap.selectedAtIso)
      ) ||
      capture.captureMode !== "automatic_pose_trigger")
  )
    return false;
  if (
    target.acquiredAnchor !== null &&
    (!object(target.acquiredAnchor) ||
      !isConfirmationPoint(target.acquiredAnchor.point) ||
      !(target.acquiredAnchor.source === null || text(target.acquiredAnchor.source)) ||
      capture.captureMode !== "automatic_pose_trigger")
  )
    return false;
  return (
    capture.captureMode !== "imported_video" ||
    (trigger.startMs === 0 &&
      trigger.endMs === capture.durationMs &&
      trigger.peakMotionMs === null &&
      trigger.confidence === 1 &&
      trigger.modelVersion === "imported-full-clip-1")
  );
}

export interface ConfirmationRecordRowBinding {
  id: unknown;
  captureId: unknown;
  createdAtIso: unknown;
  engineVersion: unknown;
  scoringModelVersion: unknown;
}

export type VerifiedCompletedCaptureRecord = Exclude<
  CaptureAnalysisRecord,
  NeedsTechniqueConfirmationRecord
> & {
  result: ShotAnalysis;
};

function timeWindow(
  value: unknown,
): value is Record<string, unknown> & { startMs: number; endMs: number } {
  return (
    object(value) &&
    finite(value.startMs) &&
    value.startMs >= 0 &&
    finite(value.endMs) &&
    value.endMs >= value.startMs
  );
}

function scoreValue(value: unknown, maximum: number): value is number {
  return finite(value) && value >= 0 && value <= maximum;
}

function shotAnalysis(value: unknown): value is ShotAnalysis {
  if (
    !object(value) ||
    !uuid(value.id) ||
    !(value.sessionId === null || uuid(value.sessionId)) ||
    !member(value.shotType, SHOT_TYPES) ||
    !member(value.cameraView, ["side", "rear_oblique"]) ||
    !member(value.handedness, ["right", "left", "ambidextrous"]) ||
    !isConfirmationTimestamp(value.capturedAtIso) ||
    !timeWindow(value.timestamps) ||
    !object(value.timestamps) ||
    !(
      value.timestamps.contactMs === null ||
      (finite(value.timestamps.contactMs) &&
        value.timestamps.contactMs >= value.timestamps.startMs &&
        value.timestamps.contactMs <= value.timestamps.endMs)
    ) ||
    !Array.isArray(value.phases) ||
    !value.phases.every(
      (phase: unknown) =>
        object(phase) &&
        member(phase.key, PHASES) &&
        timeWindow(phase) &&
        finite(phase.representativeMs) &&
        phase.representativeMs >= phase.startMs &&
        phase.representativeMs <= phase.endMs &&
        unit(phase.confidence),
    ) ||
    !Array.isArray(value.measurements) ||
    !value.measurements.every(
      (measurement: unknown) =>
        object(measurement) &&
        text(measurement.metricKey) &&
        finite(measurement.value) &&
        unit(measurement.confidence) &&
        member(measurement.unit, ["normalized", "ratio", "degrees", "ms", "count"]) &&
        measurement.source === "real",
    ) ||
    !Array.isArray(value.checkpoints) ||
    !value.checkpoints.every(
      (checkpoint: unknown) =>
        object(checkpoint) &&
        member(checkpoint.key, CHECKPOINTS) &&
        (checkpoint.score === null || scoreValue(checkpoint.score, 100)) &&
        unit(checkpoint.confidence) &&
        unit(checkpoint.severity) &&
        typeof checkpoint.applicable === "boolean" &&
        member(checkpoint.band, ["green", "yellow", "red", "unscored"]) &&
        member(checkpoint.direction, FAULT_DIRECTIONS),
    ) ||
    !unit(value.analysisConfidence) ||
    !member(value.resultKind, ["scored", "low_confidence"]) ||
    (value.resultKind === "scored"
      ? !scoreValue(value.overallScore, 10)
      : value.overallScore !== null) ||
    !(value.guidance === null || text(value.guidance)) ||
    !(
      value.priorityFix === null ||
      (object(value.priorityFix) &&
        member(value.priorityFix.checkpoint, CHECKPOINTS) &&
        text(value.priorityFix.reasonKey) &&
        unit(value.priorityFix.severity) &&
        unit(value.priorityFix.confidence))
    ) ||
    !object(value.versionVector) ||
    ![
      "appVersion",
      "modelBundleVersion",
      "poseModelVersion",
      "paddleModelVersion",
      "strokeDetectorVersion",
      "phaseModelVersion",
      "scoringModelVersion",
      "shotConfigVersion",
    ].every((key) => object(value.versionVector) && text(value.versionVector[key])) ||
    value.source !== "real"
  )
    return false;
  return true;
}

/** Runtime storage validation for completed replay; never a new scoring gate. */
export function isVerifiedCompletedCaptureRecord(
  value: unknown,
  row?: ConfirmationRecordRowBinding,
): value is VerifiedCompletedCaptureRecord {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !(value.kind === undefined || value.kind === "analyzed") ||
    value.confirmationReason !== undefined ||
    !uuid(value.id) ||
    !uuid(value.captureId) ||
    !isConfirmationTimestamp(value.createdAtIso) ||
    value.engineVersion !== "fusion-2" ||
    value.strokeTaxonomyVersion !== "pickleball-taxonomy-v2" ||
    !isStrokeIntentEnvelope(value.strokeIntent) ||
    !modalities(value.modalities) ||
    !Array.isArray(value.modelRuns) ||
    !value.modelRuns.every(modelRun) ||
    !provenance(value.provenance) ||
    !shotAnalysis(value.result) ||
    value.result.id !== value.id ||
    !object(value.strokeResolution) ||
    !member(value.strokeResolution.kind, ["declared", "predicted"]) ||
    value.strokeResolution.shotType !== value.result.shotType ||
    (value.strokeResolution.kind === "predicted" && !unit(value.strokeResolution.confidence)) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(evidenceRef) ||
    !Array.isArray(value.faults) ||
    !value.faults.every(
      (fault: unknown) =>
        object(fault) &&
        text(fault.code) &&
        text(fault.checkpoint) &&
        text(fault.direction) &&
        unit(fault.severity) &&
        unit(fault.confidence) &&
        Array.isArray(fault.evidence) &&
        fault.evidence.every(evidenceRef),
    ) ||
    !object(value.uncertainty) ||
    !unit(value.uncertainty.analysisConfidence) ||
    !member(value.uncertainty.presentation, ["normal", "lower_confidence", "abstain"]) ||
    !object(value.uncertainty.perCheckpoint) ||
    !Object.values(value.uncertainty.perCheckpoint).every(unit) ||
    !strings(value.uncertainty.limitingFactors) ||
    !Array.isArray(value.shadow) ||
    !value.shadow.every(
      (shadow: unknown) =>
        object(shadow) &&
        modelRun(shadow.run) &&
        (shadow.overallScore === null || scoreValue(shadow.overallScore, 10)) &&
        (shadow.analysisConfidence === null || unit(shadow.analysisConfidence)),
    ) ||
    !(value.observationHash === undefined || hash(value.observationHash)) ||
    !(value.captureEnvelope === undefined || envelope(value.captureEnvelope)) ||
    !(value.inputSelection === undefined || isAnalysisInputSelectionSnapshot(value.inputSelection))
  )
    return false;
  const trace = value.provenance;
  const result = value.result;
  const createdAtIso = value.createdAtIso;
  if (
    row &&
    (value.id !== row.id ||
      value.captureId !== row.captureId ||
      createdAtIso !== row.createdAtIso ||
      value.engineVersion !== row.engineVersion ||
      result.versionVector.scoringModelVersion !== row.scoringModelVersion)
  )
    return false;
  if (
    trace.pipelineVersion !== value.engineVersion ||
    trace.taxonomyVersion !== value.strokeTaxonomyVersion ||
    trace.recordedAtIso !== createdAtIso ||
    trace.appVersion !== result.versionVector.appVersion ||
    trace.scoreVersion !== result.versionVector.scoringModelVersion ||
    trace.captureEnvelopeVersion !==
      (value.captureEnvelope?.thresholdsVersion ?? CAPTURE_ENVELOPE_VERSION_NOT_MEASURED) ||
    trace.drillMappingVersion !==
      drillMappingVersionForProfile(value.strokeIntent.resolvedProfileId) ||
    Date.parse(result.capturedAtIso) > Date.parse(createdAtIso) ||
    new Set(value.modelRuns.map((run) => run.id)).size !== value.modelRuns.length ||
    new Set(trace.providerVersions.map((model) => `${model.providerId}@${model.modelVersion}`))
      .size !== trace.providerVersions.length ||
    value.modelRuns.some(
      (run) =>
        Date.parse(run.completedAtIso) > Date.parse(createdAtIso) ||
        !trace.providerVersions.some((model) => sameModel(model, run.model)),
    ) ||
    !value.modelRuns.some(
      (run) =>
        run.task === "technique_scoring" &&
        run.status === "succeeded" &&
        run.model.modelVersion === trace.scoreVersion,
    ) ||
    !predictionHasProducer(value.strokeIntent, value.modelRuns, trace) ||
    value.evidence.some(
      (entry) =>
        !trace.providerVersions.some((model) => model.providerId === entry.producedByProviderId),
    )
  )
    return false;
  const selection = value.inputSelection;
  return (
    selection === undefined ||
    (selection.captureId === value.captureId &&
      selection.observationHash === value.observationHash &&
      selection.capture.capturedAtIso === result.capturedAtIso &&
      selection.capture.poseModelVersion === result.versionVector.poseModelVersion &&
      selection.trigger.modelVersion === result.versionVector.strokeDetectorVersion &&
      selection.handedness === result.handedness &&
      selection.cameraView === result.cameraView &&
      selection.declaredStroke === value.strokeIntent.declaredStroke &&
      result.timestamps.startMs === selection.trigger.startMs &&
      result.timestamps.endMs === selection.trigger.endMs)
  );
}

export function parseNeedsTechniqueConfirmationRecord(
  value: unknown,
  row?: ConfirmationRecordRowBinding,
): Result<VerifiedTechniqueConfirmationRecord> {
  const invalid = () =>
    fail<VerifiedTechniqueConfirmationRecord>(
      failure(
        "permanent",
        "confirmation.corrupt",
        "The saved technique confirmation could not be verified.",
      ),
    );
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "needs_technique_confirmation" ||
    !member(value.confirmationReason, [
      "family_only",
      "ambiguous_technique",
      "unsupported_technique",
      "unvalidated_prediction",
      "unresolved_technique",
    ]) ||
    !uuid(value.id) ||
    !uuid(value.captureId) ||
    !isConfirmationTimestamp(value.createdAtIso) ||
    value.engineVersion !== "fusion-2" ||
    value.strokeTaxonomyVersion !== "pickleball-taxonomy-v2" ||
    value.result !== null ||
    !isStrokeIntentEnvelope(value.strokeIntent) ||
    !object(value.strokeResolution) ||
    value.strokeResolution.kind !== "unresolved" ||
    !text(value.strokeResolution.reason) ||
    !modalities(value.modalities) ||
    !Array.isArray(value.modelRuns) ||
    !value.modelRuns.every(modelRun) ||
    !provenance(value.provenance) ||
    !Array.isArray(value.evidence) ||
    !value.evidence.every(evidenceRef) ||
    !Array.isArray(value.faults) ||
    value.faults.length !== 0 ||
    !Array.isArray(value.shadow) ||
    value.shadow.length !== 0 ||
    !object(value.uncertainty) ||
    value.uncertainty.analysisConfidence !== 0 ||
    value.uncertainty.presentation !== "abstain" ||
    !object(value.uncertainty.perCheckpoint) ||
    Object.keys(value.uncertainty.perCheckpoint).length !== 0 ||
    !strings(value.uncertainty.limitingFactors) ||
    !hash(value.observationHash) ||
    !envelope(value.captureEnvelope)
  )
    return invalid();
  if (
    row &&
    (value.id !== row.id ||
      value.captureId !== row.captureId ||
      value.createdAtIso !== row.createdAtIso ||
      value.engineVersion !== row.engineVersion ||
      row.scoringModelVersion !== "abstained")
  )
    return invalid();
  if (value.inputSelection === undefined)
    return fail(
      failure(
        "permanent",
        "confirmation.legacy",
        "This older confirmation has no immutable input selection.",
      ),
    );
  if (!isAnalysisInputSelectionSnapshot(value.inputSelection)) return invalid();
  const selection = value.inputSelection;
  const intent = value.strokeIntent;
  const trace = value.provenance;
  const createdAtIso = value.createdAtIso;
  if (
    selection.captureId !== value.captureId ||
    selection.observationHash !== value.observationHash ||
    selection.declaredStroke !== intent.declaredStroke ||
    Date.parse(selection.capture.capturedAtIso) > Date.parse(value.createdAtIso) ||
    (selection.target.userSelection !== null &&
      Date.parse(selection.target.userSelection.selectedAtIso) > Date.parse(value.createdAtIso)) ||
    (selection.target.guidedStartTap?.selectedAtIso != null &&
      Date.parse(selection.target.guidedStartTap.selectedAtIso) > Date.parse(value.createdAtIso)) ||
    trace.pipelineVersion !== value.engineVersion ||
    trace.taxonomyVersion !== value.strokeTaxonomyVersion ||
    trace.recordedAtIso !== value.createdAtIso ||
    trace.captureEnvelopeVersion !==
      (value.captureEnvelope?.thresholdsVersion ?? CAPTURE_ENVELOPE_VERSION_NOT_MEASURED) ||
    trace.drillMappingVersion !==
      (intent.resolutionBasis === "predicted_family"
        ? drillMappingVersionForProfile(intent.resolvedProfileId)
        : DRILL_MAPPING_VERSION_UNRESOLVED) ||
    new Set(value.modelRuns.map((run) => run.id)).size !== value.modelRuns.length ||
    new Set(trace.providerVersions.map((model) => `${model.providerId}@${model.modelVersion}`))
      .size !== trace.providerVersions.length ||
    value.modelRuns.some(
      (run) =>
        Date.parse(run.completedAtIso) > Date.parse(createdAtIso) ||
        !trace.providerVersions.some((model) => sameModel(model, run.model)),
    ) ||
    value.modelRuns.some(
      (run) =>
        run.task === "technique_scoring" &&
        (run.status === "succeeded" ||
          run.failure?.code !== "scoring.unsupported_stroke" ||
          run.model.modelVersion !== trace.scoreVersion),
    ) ||
    !predictionHasProducer(intent, value.modelRuns, trace) ||
    !trace.providerVersions.some(
      (model) => model.modelVersion === selection.capture.poseModelVersion,
    ) ||
    !trace.providerVersions.some(
      (model) => model.modelVersion === selection.trigger.modelVersion,
    ) ||
    value.evidence.some(
      (entry) =>
        !trace.providerVersions.some((model) => model.providerId === entry.producedByProviderId) ||
        (entry.window !== null && entry.window.endMs > selection.capture.durationMs),
    )
  )
    return invalid();
  if (
    (value.confirmationReason === "family_only") !==
    (intent.resolutionBasis === "predicted_family")
  )
    return invalid();
  if (intent.resolutionBasis === "declared") {
    const expected = resolveSlugProfileId(intent.declaredStroke!, selection.declaredCanonical);
    if (
      expected.profileId !== intent.resolvedProfileId ||
      expected.profileVersion !== intent.resolvedProfileVersion
    )
      return invalid();
    const expectedReason =
      expected.profileId === null && selection.declaredCanonical === null
        ? "ambiguous_technique"
        : "unsupported_technique";
    if (
      value.confirmationReason !== expectedReason ||
      (expected.profileId !== null &&
        !value.modelRuns.some(
          (run) =>
            run.task === "technique_scoring" && run.failure?.code === "scoring.unsupported_stroke",
        ))
    )
      return invalid();
    const disagreement =
      (intent.predictedStroke &&
        detectHierarchicalDisagreement(
          intent.declaredStroke!,
          intent.predictedStroke,
          selection.declaredCanonical,
        )) ??
      detectFlatDisagreement(intent.declaredStroke!, intent.flatPrediction ?? null);
    if (
      disagreement?.declared !== intent.disagreement?.declared ||
      disagreement?.predictedLabel !== intent.disagreement?.predictedLabel ||
      disagreement?.basis !== intent.disagreement?.basis
    )
      return invalid();
  }
  if (intent.resolutionBasis === "predicted_l3") {
    const flat = intent.flatPrediction;
    const predicted = intent.predictedStroke
      ? resolvePredictedProfile(intent.predictedStroke)
      : null;
    const expected =
      flat && flat.shotType !== "unknown" && flat.confidence >= 0.8
        ? resolveSlugProfileId(flat.shotType)
        : predicted?.kind === "leaf"
          ? predicted
          : null;
    if (
      !expected ||
      expected.profileId !== intent.resolvedProfileId ||
      expected.profileVersion !== intent.resolvedProfileVersion
    )
      return invalid();
    const expectedReason =
      expected.profileId !== null
        ? "unvalidated_prediction"
        : selection.declaredCanonical === null
          ? "ambiguous_technique"
          : "unsupported_technique";
    if (value.confirmationReason !== expectedReason) return invalid();
  }
  if (intent.resolutionBasis === "abstained") {
    const predicted = intent.predictedStroke
      ? resolvePredictedProfile(intent.predictedStroke)
      : null;
    if (
      (predicted && predicted.kind !== "abstain") ||
      (intent.flatPrediction &&
        intent.flatPrediction.shotType !== "unknown" &&
        intent.flatPrediction.confidence >= 0.8)
    )
      return invalid();
    const expectedReason =
      predicted?.kind === "abstain" && predicted.reason === "auto_stroke_leaf_not_in_registry"
        ? "unsupported_technique"
        : "unresolved_technique";
    if (value.confirmationReason !== expectedReason) return invalid();
  }
  // Construct from runtime-checked fields rather than asserting an unknown
  // JSON object into the admission type. The empty fields were checked above;
  // this does not repair an incomplete record or synthesize missing evidence.
  const record: VerifiedTechniqueConfirmationRecord = {
    ...value,
    schemaVersion: value.schemaVersion,
    id: value.id,
    captureId: value.captureId,
    createdAtIso: value.createdAtIso,
    engineVersion: value.engineVersion,
    strokeTaxonomyVersion: value.strokeTaxonomyVersion,
    kind: value.kind,
    confirmationReason: value.confirmationReason,
    result: null,
    strokeResolution: { kind: "unresolved", reason: value.strokeResolution.reason },
    strokeIntent: intent,
    modalities: value.modalities,
    modelRuns: value.modelRuns,
    provenance: trace,
    evidence: value.evidence,
    faults: [],
    shadow: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: "abstain",
      perCheckpoint: {},
      limitingFactors: value.uncertainty.limitingFactors,
    },
    observationHash: value.observationHash,
    captureEnvelope: value.captureEnvelope,
    inputSelection: selection,
  };
  return explainAnalysisRun(record).ok ? ok(record) : invalid();
}
