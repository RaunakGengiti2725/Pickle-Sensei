import type { Handedness, Result, ShotTypeSlug } from "@pickle/shared-types";
import {
  SELECTABLE_TECHNIQUES_V1,
  SHARED_SIDE_PROFILES_V1,
  TECHNIQUE_ANALYSIS_PROFILES_V1,
  type SharedSideKey,
} from "@pickle/shared-types";
import type {
  AnalysisRecord,
  BallTrack,
  PaddleTrack,
  PoseSequence,
  StrokePrediction as FlatStrokePrediction,
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
 *        No leaf slug exists, so the slug-conditioned stages (biomechanics,
 *        scoring, faults, coaching) are honestly skipped — running them
 *        would require fabricating a specific technique;
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
 * The producing classifier today is swing-lab's stroke-heuristic-1
 * (`classifyStroke`): measured geometry, NOT a learned or calibrated model.
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
 * bounce is unobserved and stroke-heuristic-1 refuses L3. The predicted_l3
 * route is exercised only when a classifier genuinely commits a leaf; this
 * module must never promote a depth-2 prediction to a leaf.
 */
export const AUTO_RESOLUTION_MIN_CONFIDENCE = 0.5;

/** How the analysis profile was chosen for this run. */
export type StrokeResolutionBasis =
  | "declared"
  | "predicted_l3"
  | "predicted_family"
  | "abstained";

/**
 * Hierarchical stroke prediction — structurally compatible with the output
 * of swing-lab's `classifyStroke` (stroke-heuristic-1), so an adapter can
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
}

/** AnalysisRecord + the stroke-intent envelope (additive, non-breaking). */
export interface CaptureAnalysisRecord extends AnalysisRecord {
  strokeIntent: StrokeIntentEnvelope;
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
  if (prediction.confidence < AUTO_RESOLUTION_MIN_CONFIDENCE) {
    return { kind: "abstain", reason: "auto_stroke_confidence_below_floor" };
  }
  if (prediction.leaf !== null) {
    const technique = SELECTABLE_TECHNIQUES_V1.find(
      (entry) => entry.canonical === prediction.leaf,
    );
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
  }
  const candidates = canonicalsForSlug(slug);
  if (candidates.length === 1) {
    const profile = TECHNIQUE_ANALYSIS_PROFILES_V1[candidates[0]!]!;
    return { profileId: profile.canonical, profileVersion: profile.profileVersion };
  }
  return { profileId: null, profileVersion: null };
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
): StrokeDisagreement | null {
  if (prediction.label === "UNKNOWN" || prediction.leaf === "UNKNOWN") return null;
  if (prediction.confidence < AUTO_RESOLUTION_MIN_CONFIDENCE) return null;
  const declaredSet = canonicalsForSlug(declared);
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
  if (prediction.confidence < AUTO_RESOLUTION_MIN_CONFIDENCE) return null;
  if (prediction.shotType === declared) return null;
  return { declared, predictedLabel: prediction.shotType, basis: "slug_vs_declared" };
}
