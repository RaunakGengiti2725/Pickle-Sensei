import type { ShotTypeSlug } from "./domain.js";

/**
 * TECHNIQUE INTENT — one canonical architecture for TAP, VOICE, and AUTO.
 *
 * The user's declared technique is CONTEXT for analysis (never ground truth:
 * declaredStroke and predictedStroke stay separate records everywhere). All
 * three input methods resolve into the same TechniqueIntent, and every
 * resolution terminates in this versioned registry — natural language can
 * never invent a technique route that the intelligence does not support.
 *
 * Vocabulary layers (all versioned, none duplicated):
 *  - SELECTABLE_TECHNIQUES_V1 — the product-selectable canonical set,
 *    mirroring the v3 recognition taxonomy the analyzer can actually verify;
 *  - pickleballTaxonomy.ts     — the fine-grained 61-technique coach/label
 *    vocabulary (annotation + future expert program);
 *  - ShotTypeSlug              — the legacy capture-pipeline slug, mapped
 *    here so intent flows into the existing zero-touch flow unchanged.
 */

export const TECHNIQUE_INTENT_VERSION = "technique-intent-v1" as const;

export interface SelectableTechnique {
  /** Canonical v3 recognition label — the analyzer's verification target. */
  canonical: string;
  displayName: string;
  /** Legacy capture slug consumed by today's pipeline (null = no legacy slot). */
  legacySlug: ShotTypeSlug | null;
  family: "drive" | "dink" | "volley" | "serve" | "return" | "drop" | "reset" | "overhead" | "speedup";
}

export const SELECTABLE_TECHNIQUES_V1: readonly SelectableTechnique[] = [
  { canonical: "FOREHAND_DRIVE", displayName: "Forehand Drive", legacySlug: "forehand_drive", family: "drive" },
  { canonical: "BACKHAND_DRIVE", displayName: "Backhand Drive", legacySlug: "backhand_drive", family: "drive" },
  { canonical: "FOREHAND_DINK", displayName: "Forehand Dink", legacySlug: "dink", family: "dink" },
  { canonical: "BACKHAND_DINK", displayName: "Backhand Dink", legacySlug: "dink", family: "dink" },
  { canonical: "FOREHAND_VOLLEY", displayName: "Forehand Volley", legacySlug: "volley", family: "volley" },
  { canonical: "BACKHAND_VOLLEY", displayName: "Backhand Volley", legacySlug: "volley", family: "volley" },
  { canonical: "SERVE", displayName: "Serve", legacySlug: "serve", family: "serve" },
  { canonical: "RETURN", displayName: "Return", legacySlug: "return", family: "return" },
  { canonical: "DROP", displayName: "Third-Shot Drop", legacySlug: "third_shot_drop", family: "drop" },
  { canonical: "RESET", displayName: "Reset", legacySlug: "dink", family: "reset" },
  { canonical: "OVERHEAD", displayName: "Overhead", legacySlug: "overhead", family: "overhead" },
  { canonical: "SPEEDUP", displayName: "Speedup", legacySlug: "volley", family: "speedup" },
] as const;

export type TechniqueIntentSource = "tap" | "voice" | "auto";

export interface TechniqueIntent {
  version: typeof TECHNIQUE_INTENT_VERSION;
  source: TechniqueIntentSource;
  /** null = AUTO DETECT (the analyzer classifies independently either way). */
  canonical: string | null;
  legacySlug: ShotTypeSlug | null;
  /** Resolver confidence for voice/text; 1 for tap; null for auto. */
  confidence: number | null;
  /** Raw user words for voice/text intent (provenance; never a model route). */
  rawUserText?: string;
}

export type IntentResolution =
  | { status: "resolved"; technique: SelectableTechnique; confidence: number }
  | { status: "ambiguous"; options: SelectableTechnique[]; reason: string }
  | { status: "auto" }
  | { status: "unknown"; reason: string };

const SIDE_WORDS: Array<[RegExp, "FOREHAND" | "BACKHAND"]> = [
  [/\bfore\s?hand\b|\bfh\b/, "FOREHAND"],
  [/\bback\s?hand\b|\bbh\b/, "BACKHAND"],
];
const ACTION_WORDS: Array<[RegExp, SelectableTechnique["family"]]> = [
  [/\bdrives?\b|\bdriving\b/, "drive"],
  [/\bdinks?\b|\bdinking\b/, "dink"],
  [/\bvolley(s|ing)?\b/, "volley"],
  [/\bserves?\b|\bserving\b/, "serve"],
  [/\breturns?\b|\breturning\b/, "return"],
  [/\b(third|3rd)[-\s]?shot\b|\bdrops?\b|\bdrop\s?shot\b/, "drop"],
  [/\bresets?\b|\bresetting\b/, "reset"],
  [/\boverheads?\b|\bsmash(es)?\b|\bslams?\b/, "overhead"],
  [/\bspeed\s?ups?\b|\bspeedups?\b|\battacks?\b/, "speedup"],
];
const AUTO_WORDS = /\bauto\b|\bdetect\b|\banything\b|\bwhatever\b|\bnot sure\b|\bdon'?t know\b/;

/**
 * Deterministic natural-language → canonical technique resolution.
 * NOT a language model: a bounded synonym/side grammar whose every output
 * terminates in SELECTABLE_TECHNIQUES_V1. Genuinely ambiguous phrases return
 * the narrowed option set for the UI to disambiguate — never a silent guess.
 */
export function resolveTechniqueIntent(rawText: string): IntentResolution {
  const text = rawText.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length === 0) return { status: "unknown", reason: "empty input" };
  if (AUTO_WORDS.test(text)) return { status: "auto" };

  let side: "FOREHAND" | "BACKHAND" | null = null;
  for (const [pattern, value] of SIDE_WORDS) {
    if (pattern.test(text)) side = value;
  }
  const families = ACTION_WORDS.filter(([pattern]) => pattern.test(text)).map(([, family]) => family);

  if (families.length > 1) {
    const options = SELECTABLE_TECHNIQUES_V1.filter(
      (technique) =>
        families.includes(technique.family) &&
        (side === null || technique.canonical.startsWith(side) || !technique.canonical.includes("HAND")),
    );
    return { status: "ambiguous", options: [...options], reason: "multiple techniques mentioned" };
  }
  const family = families[0] ?? null;

  if (family !== null) {
    const inFamily = SELECTABLE_TECHNIQUES_V1.filter((technique) => technique.family === family);
    if (inFamily.length === 1) return { status: "resolved", technique: inFamily[0]!, confidence: side ? 0.95 : 0.9 };
    if (side !== null) {
      const match = inFamily.find((technique) => technique.canonical.startsWith(side));
      if (match) return { status: "resolved", technique: match, confidence: 0.95 };
    }
    return { status: "ambiguous", options: [...inFamily], reason: `which side of the ${family}?` };
  }
  if (side !== null) {
    const options = SELECTABLE_TECHNIQUES_V1.filter((technique) => technique.canonical.startsWith(side));
    return { status: "ambiguous", options: [...options], reason: `${side.toLowerCase()} what — drive, dink, or volley?` };
  }
  return { status: "unknown", reason: "no known technique words" };
}

/**
 * TECHNIQUE ANALYSIS PROFILES — versioned, stroke-conditioned interpretation.
 * Shared perception (player/pose/paddle/ball/contact/temporal) is identical
 * for every profile; INTERPRETATION is conditioned on technique. Every field
 * is honest about today's state: no technique evaluator is validated, so all
 * profiles carry BLOCKED_ON_VALIDATION and the Result must not render scores.
 */
export interface TechniqueAnalysisProfile {
  canonical: string;
  profileVersion: string;
  /** Event prior: expected action family for proposal ranking (context only). */
  expectedActionFamily: SelectableTechnique["family"];
  phaseSchemaVersion: string;
  measurementSchemaVersion: string;
  techniqueEvaluator: "BLOCKED_ON_VALIDATION";
  faultTaxonomyVersion: "pending-expert-program";
  drillMappingVersion: "none";
  requiredModalities: ReadonlyArray<"pose" | "event">;
  optionalModalities: ReadonlyArray<"paddle" | "ball" | "contact">;
  abstentionPolicy: "abstain-over-invent";
}

export const TECHNIQUE_ANALYSIS_PROFILES_V1: Readonly<Record<string, TechniqueAnalysisProfile>> =
  Object.fromEntries(
    SELECTABLE_TECHNIQUES_V1.map((technique) => [
      technique.canonical,
      {
        canonical: technique.canonical,
        profileVersion: "technique-profile-v1",
        expectedActionFamily: technique.family,
        phaseSchemaVersion: "phase.paddle-temporal.v2",
        measurementSchemaVersion: "swing-metrics-v1 (research)",
        techniqueEvaluator: "BLOCKED_ON_VALIDATION",
        faultTaxonomyVersion: "pending-expert-program",
        drillMappingVersion: "none",
        requiredModalities: ["pose", "event"],
        optionalModalities: ["paddle", "ball", "contact"],
        abstentionPolicy: "abstain-over-invent",
      } satisfies TechniqueAnalysisProfile,
    ]),
  );

/**
 * SHARED SIDE PROFILES — the AUTO DETECT (declared-null) resolution targets
 * for predictions that honestly stop at taxonomy depth 2 (FOREHAND/BACKHAND).
 *
 * Today's hierarchical stroke classifier (stroke-heuristic-1) cannot commit
 * to a leaf technique without bounce observation, so a depth-2 prediction is
 * the deepest defensible identity for most swings. These profiles make that
 * depth an explicit, versioned registry entry — an AUTO run resolves to a
 * shared side profile instead of inventing a leaf technique. Nothing outside
 * this registry (or TECHNIQUE_ANALYSIS_PROFILES_V1) can become a route.
 *
 * Same honesty contract as the leaf profiles: no validated evaluator exists,
 * so shared profiles carry BLOCKED_ON_VALIDATION and never render scores.
 */
export type SharedSideKey = "FOREHAND" | "BACKHAND";

export interface SharedSideProfile {
  /** Registry id, e.g. "SHARED_FOREHAND_SWING". Never a leaf canonical. */
  id: string;
  profileVersion: string;
  /** Taxonomy depth this profile is defensible at. */
  taxonomyDepth: 2;
  side: SharedSideKey;
  /** Leaf canonicals this shared profile covers (all registry members). */
  covers: readonly string[];
  phaseSchemaVersion: string;
  measurementSchemaVersion: string;
  techniqueEvaluator: "BLOCKED_ON_VALIDATION";
  faultTaxonomyVersion: "pending-expert-program";
  drillMappingVersion: "none";
  requiredModalities: ReadonlyArray<"pose" | "event">;
  optionalModalities: ReadonlyArray<"paddle" | "ball" | "contact">;
  abstentionPolicy: "abstain-over-invent";
}

function sharedSideProfile(side: SharedSideKey): SharedSideProfile {
  return {
    id: `SHARED_${side}_SWING`,
    profileVersion: "technique-profile-v1",
    taxonomyDepth: 2,
    side,
    covers: SELECTABLE_TECHNIQUES_V1.filter((technique) =>
      technique.canonical.startsWith(`${side}_`),
    ).map((technique) => technique.canonical),
    phaseSchemaVersion: "phase.paddle-temporal.v2",
    measurementSchemaVersion: "swing-metrics-v1 (research)",
    techniqueEvaluator: "BLOCKED_ON_VALIDATION",
    faultTaxonomyVersion: "pending-expert-program",
    drillMappingVersion: "none",
    requiredModalities: ["pose", "event"],
    optionalModalities: ["paddle", "ball", "contact"],
    abstentionPolicy: "abstain-over-invent",
  };
}

export const SHARED_SIDE_PROFILES_V1: Readonly<Record<SharedSideKey, SharedSideProfile>> = {
  FOREHAND: sharedSideProfile("FOREHAND"),
  BACKHAND: sharedSideProfile("BACKHAND"),
};
