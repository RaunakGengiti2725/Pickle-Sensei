import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  allFaultIds,
  DRILL_LIBRARY_V0_VERSION,
  FAULT_TAXONOMY_V0_DRAFT,
  FAULT_TAXONOMY_V0_DRAFT_VERSION,
} from "./coachReview.js";

/**
 * DRILL LIBRARY v1 — curated, versioned drill infrastructure.
 *
 *   pnpm --filter @pickle/swing-lab coach:drills   # emit derived JSON artifacts
 *
 * TRUTH CONTRACT (same as the coach-review program this feeds):
 *  - Every drill entry and every fault→drill mapping carries an explicit
 *    validation state. Machine-/engineering-proposed content is Tier-C and
 *    can NEVER be presented as coach-validated.
 *  - COACH_VALIDATED requires evidence: independent endorsements from real,
 *    provisioned coaches (opaque coachId + off-repo credentialRef + a review
 *    file reference), with the agreement stated — never averaged away.
 *  - The recommendation gate below is the ONLY sanctioned path from a fault
 *    diagnosis to a personalized drill recommendation. In production mode it
 *    abstains unless every condition is met with real coach evidence; today
 *    zero coach reviews exist, so it abstains on the entire seeded library
 *    by construction.
 *
 * Relationship to v0: DRILL_LIBRARY_V0 (coachReview.ts) stays as the schema
 * coaches currently reference from drillSuggestions. v1 supersedes it for
 * library curation and adds the mapping-evidence records and the gate; v0
 * ids are preserved in v1 (supersedes field) so existing suggestions remain
 * interpretable.
 */

export const DRILL_LIBRARY_V1_VERSION = "drill-library-v1" as const;
export const FAULT_DRILL_MAPPING_V1_VERSION = "fault-drill-mapping-v1" as const;

/** Evidence tiers, matching the corpus-wide convention: Tier-C is machine/
 * engineering-proposed and may never be presented as validated truth. */
export type DrillEvidenceTier = "C" | "GOLD";

/** UNVALIDATED = no real coach evidence (all seeds). COACH_VALIDATED may only
 * be reached through real endorsements; validators enforce this. */
export type DrillValidationState = "UNVALIDATED" | "COACH_VALIDATED";

export type StrokeFamilyKey =
  | "global"
  | "drive"
  | "dink"
  | "volley"
  | "serve"
  | "return"
  | "drop_reset"
  | "overhead"
  | "speedup";

export const STROKE_FAMILY_KEYS: readonly StrokeFamilyKey[] = [
  "global",
  "drive",
  "dink",
  "volley",
  "serve",
  "return",
  "drop_reset",
  "overhead",
  "speedup",
] as const;

/** One real coach's endorsement of a fault→drill mapping. Every field must
 * trace to the coach-review program: a provisioned coach and an on-disk
 * review file. Synthetic identities are rejected by the validator. */
export interface CoachEndorsement {
  /** Opaque pseudonymous id from datasets/coach-review/coaches.json. */
  coachId: string;
  /** Off-repo credential record reference (e.g. "cred-2026-004"). */
  coachCredentialRef: string;
  /** The review file this endorsement came from, e.g.
   * "datasets/coach-review/reviews/<reviewId>.json". */
  reviewRef: string;
  endorsedAtIso: string;
}

/** Fault→drill mapping EVIDENCE RECORD: which coaches endorsed this drill for
 * this fault, under which stroke/severity/context restrictions, and with what
 * agreement among the coaches asked. Append-only; versioned. */
export interface FaultDrillMappingV1 {
  /** Stable id: "map.<faultId>.<drillId-slug>". */
  mappingId: string;
  faultId: string;
  faultTaxonomyVersion: typeof FAULT_TAXONOMY_V0_DRAFT_VERSION;
  drillId: string;
  drillLibraryVersion: typeof DRILL_LIBRARY_V1_VERSION;
  /** Stroke families this mapping applies to (subset of the drill's own). */
  strokeFamilies: StrokeFamilyKey[];
  /** Severity band (1..3, inclusive) the mapping is endorsed for; null side =
   * unbounded. Recommending outside the band is a gate failure. */
  severityRestriction: { min: 1 | 2 | 3 | null; max: 1 | 2 | 3 | null };
  /** Context preconditions a coach attached (plain language, e.g. "player can
   * already sustain a 10-ball cooperative dink rally"). Each must be known
   * true for the specific user before the mapping may fire. */
  contextRestrictions: string[];
  /** Real endorsements only. Empty for every Tier-C proposal. */
  endorsements: CoachEndorsement[];
  /** Of the coaches ASKED about this mapping, the fraction who endorsed it.
   * null until at least the minimum panel has been asked. Disagreement is
   * preserved in the review files; this number never hides it. */
  agreement: { endorsed: number; asked: number; fraction: number } | null;
  evidenceTier: DrillEvidenceTier;
  validationState: DrillValidationState;
  /** Where the mapping proposal came from, stated plainly. */
  provenance: string;
  version: typeof FAULT_DRILL_MAPPING_V1_VERSION;
}

/** Curated drill entry. All seeds are Tier-C UNVALIDATED. */
export interface DrillEntryV1 {
  /** Stable id: "drill.<slug>". */
  drillId: string;
  name: string;
  /** v0 id this entry supersedes (id-compatible), or null for new entries. */
  supersedes: string | null;
  supportedStrokeFamilies: StrokeFamilyKey[];
  /** Mapping ids (FaultDrillMappingV1.mappingId) proposed for this drill.
   * The mapping records — not this list — carry the evidence. */
  faultMappingIds: string[];
  /** What the drill is FOR, in coach language. */
  purpose: string;
  /** Step-by-step instructions. */
  instructions: string[];
  equipment: string[];
  difficulty: "beginner" | "intermediate" | "advanced";
  repsOrDuration: string;
  progressions: string[];
  regressions: string[];
  safetyNotes: string[];
  mediaRefs: string[];
  /** null until a qualified coach endorses/authors the entry. */
  coachProvenance: null | {
    coachId: string;
    coachCredentialRef: string;
    endorsedAtIso: string;
    reviewRef: string;
  };
  /** Where the entry actually came from, stated plainly. */
  provenance: string;
  evidenceTier: DrillEvidenceTier;
  validationState: DrillValidationState;
  version: typeof DRILL_LIBRARY_V1_VERSION;
}

/* ------------------------------------------------------------------------ *
 * VALIDATORS — structural honesty is enforced, not assumed
 * ------------------------------------------------------------------------ */

const DRILL_ID_PATTERN = /^drill\.[a-z0-9][a-z0-9-]{1,63}$/;
const MAPPING_ID_PATTERN = /^map\.[a-z0-9_.-]+\.[a-z0-9-]+$/;
const COACH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/i;
const SYNTHETIC_ID = /synthetic|demo|fake|placeholder|test[-_]?coach/i;

/** Minimum independent real-coach endorsements before a mapping may be
 * COACH_VALIDATED. Matches the review program's requiredReviewsTarget. */
export const MIN_INDEPENDENT_COACH_ENDORSEMENTS = 2;
/** Minimum agreement (endorsed/asked) for a validated mapping. */
export const MIN_MAPPING_AGREEMENT = 0.7;

export function validateDrillEntryV1(entry: DrillEntryV1): string[] {
  const problems: string[] = [];
  if (!DRILL_ID_PATTERN.test(entry.drillId)) {
    problems.push(`drillId ${entry.drillId} must match ${DRILL_ID_PATTERN}`);
  }
  if (entry.version !== DRILL_LIBRARY_V1_VERSION) {
    problems.push(`version must be ${DRILL_LIBRARY_V1_VERSION}`);
  }
  if (entry.name.trim().length < 3) problems.push("name required");
  if (entry.purpose.trim().length < 10) problems.push("purpose required (≥10 chars)");
  if (entry.instructions.length === 0) problems.push("instructions[] requires ≥1 step");
  if (entry.supportedStrokeFamilies.length === 0) {
    problems.push("supportedStrokeFamilies requires ≥1 family");
  }
  for (const family of entry.supportedStrokeFamilies) {
    if (!STROKE_FAMILY_KEYS.includes(family)) problems.push(`unknown stroke family ${family}`);
  }
  if (entry.validationState === "COACH_VALIDATED") {
    if (entry.evidenceTier !== "GOLD") {
      problems.push("COACH_VALIDATED entries must be evidenceTier GOLD");
    }
    const prov = entry.coachProvenance;
    if (!prov) {
      problems.push("COACH_VALIDATED requires coachProvenance");
    } else {
      if (!COACH_ID_PATTERN.test(prov.coachId) || SYNTHETIC_ID.test(prov.coachId)) {
        problems.push("coachProvenance.coachId must be a real provisioned coach id");
      }
      if (!prov.coachCredentialRef) problems.push("coachProvenance.coachCredentialRef required");
      if (!prov.reviewRef.startsWith("datasets/coach-review/reviews/")) {
        problems.push("coachProvenance.reviewRef must point into datasets/coach-review/reviews/");
      }
      if (Number.isNaN(Date.parse(prov.endorsedAtIso))) {
        problems.push("coachProvenance.endorsedAtIso must be an ISO timestamp");
      }
    }
  } else {
    if (entry.evidenceTier === "GOLD") {
      problems.push("UNVALIDATED entries can never be evidenceTier GOLD");
    }
    if (entry.coachProvenance !== null) {
      problems.push("UNVALIDATED entries must have coachProvenance null");
    }
  }
  return problems;
}

export function validateFaultDrillMappingV1(
  mapping: FaultDrillMappingV1,
  context?: { knownDrillIds?: string[]; knownFaultIds?: string[] },
): string[] {
  const problems: string[] = [];
  if (!MAPPING_ID_PATTERN.test(mapping.mappingId)) {
    problems.push(`mappingId ${mapping.mappingId} must match ${MAPPING_ID_PATTERN}`);
  }
  if (mapping.version !== FAULT_DRILL_MAPPING_V1_VERSION) {
    problems.push(`version must be ${FAULT_DRILL_MAPPING_V1_VERSION}`);
  }
  if (mapping.faultTaxonomyVersion !== FAULT_TAXONOMY_V0_DRAFT_VERSION) {
    problems.push(`faultTaxonomyVersion must be ${FAULT_TAXONOMY_V0_DRAFT_VERSION}`);
  }
  if (mapping.drillLibraryVersion !== DRILL_LIBRARY_V1_VERSION) {
    problems.push(`drillLibraryVersion must be ${DRILL_LIBRARY_V1_VERSION}`);
  }
  if (context?.knownFaultIds && !context.knownFaultIds.includes(mapping.faultId)) {
    problems.push(`faultId ${mapping.faultId} not in ${FAULT_TAXONOMY_V0_DRAFT_VERSION}`);
  }
  if (context?.knownDrillIds && !context.knownDrillIds.includes(mapping.drillId)) {
    problems.push(`drillId ${mapping.drillId} not in ${DRILL_LIBRARY_V1_VERSION}`);
  }
  if (mapping.strokeFamilies.length === 0) problems.push("strokeFamilies requires ≥1 family");
  const { min, max } = mapping.severityRestriction;
  if (min !== null && max !== null && min > max) {
    problems.push("severityRestriction.min must be ≤ max");
  }
  const coachIds = new Set<string>();
  for (const [index, endorsement] of mapping.endorsements.entries()) {
    if (!COACH_ID_PATTERN.test(endorsement.coachId) || SYNTHETIC_ID.test(endorsement.coachId)) {
      problems.push(`endorsements[${index}].coachId must be a real provisioned coach id`);
    }
    if (!endorsement.coachCredentialRef) {
      problems.push(`endorsements[${index}].coachCredentialRef required`);
    }
    if (!endorsement.reviewRef.startsWith("datasets/coach-review/reviews/")) {
      problems.push(
        `endorsements[${index}].reviewRef must point into datasets/coach-review/reviews/`,
      );
    }
    if (Number.isNaN(Date.parse(endorsement.endorsedAtIso))) {
      problems.push(`endorsements[${index}].endorsedAtIso must be an ISO timestamp`);
    }
    coachIds.add(endorsement.coachId);
  }
  if (mapping.agreement !== null) {
    const { endorsed, asked, fraction } = mapping.agreement;
    if (asked <= 0 || endorsed < 0 || endorsed > asked) {
      problems.push("agreement.endorsed must be 0..asked with asked ≥ 1");
    } else if (Math.abs(fraction - endorsed / asked) > 1e-9) {
      problems.push("agreement.fraction must equal endorsed/asked");
    }
    if (endorsed !== mapping.endorsements.length) {
      problems.push("agreement.endorsed must equal endorsements.length");
    }
  }
  if (mapping.validationState === "COACH_VALIDATED") {
    if (mapping.evidenceTier !== "GOLD") {
      problems.push("COACH_VALIDATED mappings must be evidenceTier GOLD");
    }
    if (coachIds.size < MIN_INDEPENDENT_COACH_ENDORSEMENTS) {
      problems.push(
        `COACH_VALIDATED requires ≥${MIN_INDEPENDENT_COACH_ENDORSEMENTS} independent coach endorsements (have ${coachIds.size})`,
      );
    }
    if (mapping.agreement === null || mapping.agreement.fraction < MIN_MAPPING_AGREEMENT) {
      problems.push(`COACH_VALIDATED requires stated agreement ≥ ${MIN_MAPPING_AGREEMENT}`);
    }
  } else {
    if (mapping.evidenceTier === "GOLD") {
      problems.push("UNVALIDATED mappings can never be evidenceTier GOLD");
    }
    if (mapping.endorsements.length > 0) {
      problems.push(
        "UNVALIDATED mappings must carry zero endorsements — real endorsements flip the state through validation, never sit unacknowledged",
      );
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------ *
 * RECOMMENDATION GATE — the only path from fault diagnosis to a drill
 * ------------------------------------------------------------------------ */

/** Minimum diagnosis confidence before a recommendation may personalize. */
export const MIN_FAULT_DIAGNOSIS_CONFIDENCE = 0.7;

export interface DrillRecommendationInput {
  /** "production" = user-facing; "research" = lab tooling. The gate's hard
   * evidence requirements apply identically in BOTH modes; research mode only
   * changes the abstention label so tooling can show near-misses. */
  mode: "production" | "research";
  drill: DrillEntryV1;
  mapping: FaultDrillMappingV1;
  fault: {
    faultId: string;
    severity: 1 | 2 | 3;
    /** Provenance of THIS diagnosis. Only a real coach review or a validated
     * automated evaluator may feed a recommendation. */
    source: "real_coach_review" | "validated_evaluator" | "machine_proposed" | "engineer_labeled";
    confidence: number;
  };
  /** The technique analysis profile for the user's stroke, as resolved by the
   * intent registry (BLOCKED_ON_VALIDATION until real coach evidence). */
  techniqueProfile: {
    canonical: string;
    strokeFamily: StrokeFamilyKey;
    techniqueEvaluator: string;
    drillMappingVersion: string;
  };
  /** Context restrictions from the mapping resolved for THIS user: each must
   * be listed with a truth value; missing keys mean the context is unknown. */
  knownContext: Record<string, boolean>;
}

export type DrillRecommendationDecision =
  | { decision: "recommend"; drillId: string; mappingId: string }
  | { decision: "abstain"; reasons: string[] };

/**
 * A drill may be recommended ONLY when every condition holds:
 *  1. the fault diagnosis comes from a validated source with adequate confidence;
 *  2. the mapping is COACH_VALIDATED (real endorsements, stated agreement) and
 *     structurally valid, and matches the diagnosed fault;
 *  3. the drill entry itself is COACH_VALIDATED and structurally valid;
 *  4. the technique profile supports drill mapping (not BLOCKED_ON_VALIDATION,
 *     drillMappingVersion matches this library) and the stroke family is covered;
 *  5. the fault severity is within the mapping's endorsed band;
 *  6. every context restriction is KNOWN TRUE for this user.
 * Otherwise: abstain from personalized recommendation. No partial credit.
 */
export function evaluateDrillRecommendation(
  input: DrillRecommendationInput,
): DrillRecommendationDecision {
  const reasons: string[] = [];
  const { drill, mapping, fault, techniqueProfile, knownContext } = input;

  if (fault.source !== "real_coach_review" && fault.source !== "validated_evaluator") {
    reasons.push(`fault diagnosis source "${fault.source}" is not a validated source`);
  }
  if (!(
    typeof fault.confidence === "number" &&
    fault.confidence >= MIN_FAULT_DIAGNOSIS_CONFIDENCE &&
    fault.confidence <= 1
  )) {
    reasons.push(
      `fault diagnosis confidence ${fault.confidence} below required ${MIN_FAULT_DIAGNOSIS_CONFIDENCE}`,
    );
  }

  if (mapping.faultId !== fault.faultId) {
    reasons.push("mapping does not cover the diagnosed fault");
  }
  if (mapping.drillId !== drill.drillId) {
    reasons.push("mapping does not reference this drill");
  }
  if (mapping.validationState !== "COACH_VALIDATED") {
    reasons.push("mapping is not COACH_VALIDATED — no real coach evidence");
  }
  const mappingProblems = validateFaultDrillMappingV1(mapping);
  if (mappingProblems.length > 0) {
    reasons.push(...mappingProblems.map((problem) => `mapping invalid: ${problem}`));
  }

  if (drill.validationState !== "COACH_VALIDATED") {
    reasons.push("drill entry is not COACH_VALIDATED — no real coach evidence");
  }
  const drillProblems = validateDrillEntryV1(drill);
  if (drillProblems.length > 0) {
    reasons.push(...drillProblems.map((problem) => `drill invalid: ${problem}`));
  }

  if (techniqueProfile.techniqueEvaluator === "BLOCKED_ON_VALIDATION") {
    reasons.push("technique profile is BLOCKED_ON_VALIDATION — scoring/fault path not validated");
  }
  if (techniqueProfile.drillMappingVersion !== DRILL_LIBRARY_V1_VERSION) {
    reasons.push(
      `technique profile drillMappingVersion "${techniqueProfile.drillMappingVersion}" does not support ${DRILL_LIBRARY_V1_VERSION}`,
    );
  }
  if (!mapping.strokeFamilies.includes(techniqueProfile.strokeFamily)) {
    reasons.push(`mapping not endorsed for stroke family "${techniqueProfile.strokeFamily}"`);
  }
  if (
    !drill.supportedStrokeFamilies.includes(techniqueProfile.strokeFamily) &&
    !drill.supportedStrokeFamilies.includes("global")
  ) {
    reasons.push(`drill does not support stroke family "${techniqueProfile.strokeFamily}"`);
  }

  const { min, max } = mapping.severityRestriction;
  if (min !== null && fault.severity < min) {
    reasons.push(`fault severity ${fault.severity} below endorsed band (min ${min})`);
  }
  if (max !== null && fault.severity > max) {
    reasons.push(`fault severity ${fault.severity} above endorsed band (max ${max})`);
  }

  for (const restriction of mapping.contextRestrictions) {
    const known = knownContext[restriction];
    if (known === undefined) {
      reasons.push(`required context unknown: "${restriction}"`);
    } else if (known === false) {
      reasons.push(`required context not met: "${restriction}"`);
    }
  }

  if (reasons.length > 0) return { decision: "abstain", reasons };
  return { decision: "recommend", drillId: drill.drillId, mappingId: mapping.mappingId };
}

/* ------------------------------------------------------------------------ *
 * SEEDS — Tier-C, UNVALIDATED, zero endorsements. Never presented as truth.
 * ------------------------------------------------------------------------ */

const SEED_PROVENANCE =
  "engineering seed — well-known public drill, Tier-C machine/engineer-proposed; NOT coach-validated";
const SEED_MAPPING_PROVENANCE =
  "engineering proposal (Tier-C) — hypothesis for coaches to endorse or reject; zero endorsements; never recommendable";

function seedMapping(
  faultId: string,
  drillId: string,
  strokeFamilies: StrokeFamilyKey[],
  severityRestriction: FaultDrillMappingV1["severityRestriction"],
  contextRestrictions: string[],
): FaultDrillMappingV1 {
  return {
    mappingId: `map.${faultId}.${drillId.replace(/^drill\./, "")}`,
    faultId,
    faultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT_VERSION,
    drillId,
    drillLibraryVersion: DRILL_LIBRARY_V1_VERSION,
    strokeFamilies,
    severityRestriction,
    contextRestrictions,
    endorsements: [],
    agreement: null,
    evidenceTier: "C",
    validationState: "UNVALIDATED",
    provenance: SEED_MAPPING_PROVENANCE,
    version: FAULT_DRILL_MAPPING_V1_VERSION,
  };
}

export const FAULT_DRILL_MAPPINGS_V1: readonly FaultDrillMappingV1[] = [
  seedMapping(
    "dink.contact_not_out_front",
    "drill.wall-dink-rally",
    ["dink"],
    {
      min: 1,
      max: 3,
    },
    [],
  ),
  seedMapping(
    "dink.paddle_drops_between",
    "drill.wall-dink-rally",
    ["dink"],
    {
      min: 1,
      max: 2,
    },
    [],
  ),
  seedMapping("dink.lifting_trajectory", "drill.dink-target-boxes", ["dink"], { min: 1, max: 3 }, [
    "player can sustain a 10-ball cooperative dink rally",
  ]),
  seedMapping(
    "volley.paddle_below_net_ready",
    "drill.volley-wall-ready",
    ["volley"],
    {
      min: 1,
      max: 3,
    },
    [],
  ),
  seedMapping(
    "volley.overswing_follow_through",
    "drill.volley-wall-ready",
    ["volley"],
    {
      min: 1,
      max: 2,
    },
    [],
  ),
  seedMapping("drive.no_unit_turn", "drill.shadow-unit-turn", ["drive"], { min: 1, max: 3 }, []),
  seedMapping(
    "drive.late_preparation",
    "drill.shadow-unit-turn",
    ["drive"],
    {
      min: 1,
      max: 2,
    },
    [],
  ),
  seedMapping(
    "serve.inconsistent_drop_toss",
    "drill.serve-drop-consistency",
    ["serve"],
    {
      min: 1,
      max: 3,
    },
    [],
  ),
  seedMapping(
    "drop.overpowered_arc",
    "drill.third-shot-drop-ladder",
    ["drop_reset"],
    {
      min: 1,
      max: 3,
    },
    ["player has court access with a net"],
  ),
  seedMapping(
    "global.no_recovery_to_ready",
    "drill.skinny-singles",
    ["global"],
    {
      min: 1,
      max: 2,
    },
    ["player is comfortable with full-point play"],
  ),
] as const;

function seedDrill(
  entry: Omit<
    DrillEntryV1,
    "coachProvenance" | "provenance" | "evidenceTier" | "validationState" | "version"
  >,
): DrillEntryV1 {
  return {
    ...entry,
    coachProvenance: null,
    provenance: SEED_PROVENANCE,
    evidenceTier: "C",
    validationState: "UNVALIDATED",
    version: DRILL_LIBRARY_V1_VERSION,
  };
}

export const DRILL_LIBRARY_V1: {
  version: typeof DRILL_LIBRARY_V1_VERSION;
  status: string;
  drills: readonly DrillEntryV1[];
} = {
  version: DRILL_LIBRARY_V1_VERSION,
  status:
    "curated schema + Tier-C UNVALIDATED seeds. Zero coach endorsements exist; " +
    "every mapping has empty evidence and the recommendation gate abstains on " +
    "all of it in every mode. Nothing here may be presented as validated.",
  drills: [
    seedDrill({
      drillId: "drill.wall-dink-rally",
      name: "Wall dink rally",
      supersedes: "drill.wall-dink-rally",
      supportedStrokeFamilies: ["dink"],
      faultMappingIds: [
        "map.dink.contact_not_out_front.wall-dink-rally",
        "map.dink.paddle_drops_between.wall-dink-rally",
      ],
      purpose:
        "Groove out-front contact and a stable paddle face through high-repetition soft dinks.",
      instructions: [
        "Stand 7–8 ft from a wall marked with a net-height line (34 in).",
        "Rally soft dinks continuously above the line, contacting every ball out in front of the body.",
        "Keep the paddle up between contacts; reset to ready after each dink.",
      ],
      equipment: ["paddle", "ball", "wall with net-height line (34 in)"],
      difficulty: "beginner",
      repsOrDuration: "3 × 2 min continuous rally",
      progressions: [
        "alternate forehand/backhand each contact",
        "target box 6–12 in above the line",
      ],
      regressions: ["allow one bounce between contacts", "stand closer to the wall"],
      safetyNotes: ["clear wall area of obstacles; stop if wrist discomfort appears"],
      mediaRefs: [],
    }),
    seedDrill({
      drillId: "drill.dink-target-boxes",
      name: "Dink target boxes",
      supersedes: null,
      supportedStrokeFamilies: ["dink"],
      faultMappingIds: ["map.dink.lifting_trajectory.dink-target-boxes"],
      purpose: "Flatten the dink arc by demanding depth control into kitchen target zones.",
      instructions: [
        "Place two flat targets in the opponent kitchen: one near the sideline, one center.",
        "Cooperative crosscourt dink rally; score a point only when the ball lands in a target.",
        "Emphasize lifting from the legs with a quiet wrist, not scooping upward.",
      ],
      equipment: ["paddle", "balls", "court", "2 flat targets (towels or tape boxes)"],
      difficulty: "intermediate",
      repsOrDuration: "first to 10 target hits, 3 rounds",
      progressions: ["shrink targets", "alternate targets on consecutive dinks"],
      regressions: ["one large target", "feed by hand instead of rallying"],
      safetyNotes: ["use flat targets only — nothing a player could roll an ankle on"],
      mediaRefs: [],
    }),
    seedDrill({
      drillId: "drill.volley-wall-ready",
      name: "Volley wall with ready reset",
      supersedes: null,
      supportedStrokeFamilies: ["volley"],
      faultMappingIds: [
        "map.volley.paddle_below_net_ready.volley-wall-ready",
        "map.volley.overswing_follow_through.volley-wall-ready",
      ],
      purpose:
        "Keep the paddle up and the volley compact: block volleys off a wall with a forced ready reset between contacts.",
      instructions: [
        "Stand 6–7 ft from the wall, paddle at chest height in ready position.",
        "Volley continuously without letting the ball bounce, returning the paddle to ready between every contact.",
        "Keep the swing a compact block — hands finish in front of the shoulders.",
      ],
      equipment: ["paddle", "ball", "wall"],
      difficulty: "beginner",
      repsOrDuration: "4 × 45 s continuous",
      progressions: ["alternate forehand/backhand", "step closer to the wall"],
      regressions: ["allow one bounce", "slow, higher-arc feeds"],
      safetyNotes: ["stay balanced — no lunging at the wall"],
      mediaRefs: [],
    }),
    seedDrill({
      drillId: "drill.shadow-unit-turn",
      name: "Shadow swing: unit turn ladder",
      supersedes: null,
      supportedStrokeFamilies: ["drive"],
      faultMappingIds: [
        "map.drive.no_unit_turn.shadow-unit-turn",
        "map.drive.late_preparation.shadow-unit-turn",
      ],
      purpose:
        "Build an early shoulder-hip unit turn on drives through mirror-checked shadow swings, then live feeds.",
      instructions: [
        "Without a ball, rehearse the drive: turn shoulders and hips together as the split-step lands.",
        "Check in a mirror or phone video that the chest faces the sideline before the forward swing.",
        "Progress to dropped-ball feeds, calling 'turn' at the feeder's release.",
      ],
      equipment: ["paddle", "mirror or phone camera", "balls (for the fed stage)"],
      difficulty: "beginner",
      repsOrDuration: "3 × 10 shadow swings + 2 × 10 fed balls",
      progressions: ["feeder varies pace", "alternate forehand/backhand feeds"],
      regressions: ["shadow swings only, no feeds"],
      safetyNotes: ["ensure swing radius is clear of people and objects"],
      mediaRefs: [],
    }),
    seedDrill({
      drillId: "drill.serve-drop-consistency",
      name: "Serve drop consistency blocks",
      supersedes: null,
      supportedStrokeFamilies: ["serve"],
      faultMappingIds: ["map.serve.inconsistent_drop_toss.serve-drop-consistency"],
      purpose:
        "Stabilize the drop/toss so the serve contact point stops wandering: blocked repetitions with an explicit drop checkpoint.",
      instructions: [
        "Serve in blocks of 10, pausing before each serve to set the same drop height and release point.",
        "Let the ball drop from the same hand position every time; contact below the waist per rules.",
        "Track how many of 10 drops you would rate identical before adding targets.",
      ],
      equipment: ["paddle", "balls", "court"],
      difficulty: "beginner",
      repsOrDuration: "5 × 10 serves",
      progressions: ["add deep-third targets", "alternate wide/body/T targets"],
      regressions: ["drop-and-catch only (no swing) to groove the release"],
      safetyNotes: [],
      mediaRefs: [],
    }),
    seedDrill({
      drillId: "drill.third-shot-drop-ladder",
      name: "Third-shot drop ladder",
      supersedes: null,
      supportedStrokeFamilies: ["drop_reset"],
      faultMappingIds: ["map.drop.overpowered_arc.third-shot-drop-ladder"],
      purpose:
        "Take pace off the third shot: progressive distance ladder that rewards arc and kitchen landings over power.",
      instructions: [
        "Start at the kitchen line dropping balls into the opposite kitchen; step back 3 ft after 5 makes.",
        "Continue the ladder until serving-position drops; restart the rung after 3 consecutive longs.",
        "Focus on lifting with the legs and finishing the paddle toward the target, not across the body.",
      ],
      equipment: ["paddle", "balls", "court with net"],
      difficulty: "intermediate",
      repsOrDuration: "ladder to baseline, 2 full climbs",
      progressions: ["partner returns your drop and you play it out", "backhand-only ladder"],
      regressions: ["shorten the ladder", "hand-feed instead of self-feed"],
      safetyNotes: [],
      mediaRefs: [],
    }),
    seedDrill({
      drillId: "drill.skinny-singles",
      name: "Skinny singles",
      supersedes: "drill.skinny-singles",
      supportedStrokeFamilies: ["global", "serve", "return", "drive", "dink", "drop_reset"],
      faultMappingIds: ["map.global.no_recovery_to_ready.skinny-singles"],
      purpose:
        "Pressure-test whole-point habits (recovery, shot selection) on half the court with full-point consequences.",
      instructions: [
        "Play singles on half the court (straight or crosscourt halves).",
        "Play full points: serve, return, third shot, kitchen play.",
        "Between shots, recover to ready position before the opponent's contact.",
      ],
      equipment: ["paddle", "ball", "court"],
      difficulty: "intermediate",
      repsOrDuration: "games to 7, switch halves",
      progressions: ["crosscourt halves only (longer diagonal)", "third shot must be a drop"],
      regressions: ["serve-and-return only, replay the point after the 4th ball"],
      safetyNotes: ["full-court movement — warm up before playing points"],
      mediaRefs: [],
    }),
  ],
};

export function knownDrillIdsV1(): string[] {
  return DRILL_LIBRARY_V1.drills.map((drill) => drill.drillId);
}

export function mappingsForFault(faultId: string): FaultDrillMappingV1[] {
  return FAULT_DRILL_MAPPINGS_V1.filter((mapping) => mapping.faultId === faultId);
}

/** Library-level integrity check: referential integrity + per-record
 * validation + the seed honesty invariant (no validated content exists). */
export function validateDrillLibraryV1(): string[] {
  const problems: string[] = [];
  const drillIds = knownDrillIdsV1();
  const faultIds = allFaultIds();
  const mappingIds = FAULT_DRILL_MAPPINGS_V1.map((mapping) => mapping.mappingId);
  if (new Set(drillIds).size !== drillIds.length) problems.push("duplicate drillIds");
  if (new Set(mappingIds).size !== mappingIds.length) problems.push("duplicate mappingIds");
  for (const drill of DRILL_LIBRARY_V1.drills) {
    problems.push(...validateDrillEntryV1(drill).map((p) => `${drill.drillId}: ${p}`));
    for (const mappingId of drill.faultMappingIds) {
      if (!mappingIds.includes(mappingId)) {
        problems.push(`${drill.drillId}: unknown faultMappingId ${mappingId}`);
      }
    }
  }
  for (const mapping of FAULT_DRILL_MAPPINGS_V1) {
    problems.push(
      ...validateFaultDrillMappingV1(mapping, {
        knownDrillIds: drillIds,
        knownFaultIds: faultIds,
      }).map((p) => `${mapping.mappingId}: ${p}`),
    );
    const drill = DRILL_LIBRARY_V1.drills.find((entry) => entry.drillId === mapping.drillId);
    if (drill && !drill.faultMappingIds.includes(mapping.mappingId)) {
      problems.push(`${mapping.mappingId}: not back-referenced by ${mapping.drillId}`);
    }
    for (const family of mapping.strokeFamilies) {
      if (
        drill &&
        !drill.supportedStrokeFamilies.includes(family) &&
        !drill.supportedStrokeFamilies.includes("global")
      ) {
        problems.push(`${mapping.mappingId}: family ${family} not supported by ${mapping.drillId}`);
      }
    }
  }
  return problems;
}

/* ------------------------------------------------------------------------ *
 * CLI — regenerate derived artifacts (never fabricates evidence)
 * ------------------------------------------------------------------------ */

const isMain = process.argv[1]?.endsWith("drillLibrary.ts");
if (isMain) {
  const problems = validateDrillLibraryV1();
  if (problems.length > 0) {
    console.error("drill library INVALID:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else {
    const outDir = join(REPO_ROOT, "datasets/coach-review/drills");
    mkdirSync(outDir, { recursive: true });
    const generatedAtIso = new Date().toISOString();
    writeFileSync(
      join(outDir, "drill-library.v1.json"),
      JSON.stringify(
        {
          generatedAtIso,
          supersedesVersion: DRILL_LIBRARY_V0_VERSION,
          faultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT.version,
          ...DRILL_LIBRARY_V1,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(outDir, "fault-drill-mappings.v1.json"),
      JSON.stringify(
        {
          generatedAtIso,
          version: FAULT_DRILL_MAPPING_V1_VERSION,
          status:
            "Tier-C engineering proposals with ZERO coach endorsements; the recommendation gate abstains on every mapping in this file",
          gate: {
            minIndependentCoachEndorsements: MIN_INDEPENDENT_COACH_ENDORSEMENTS,
            minMappingAgreement: MIN_MAPPING_AGREEMENT,
            minFaultDiagnosisConfidence: MIN_FAULT_DIAGNOSIS_CONFIDENCE,
          },
          mappings: FAULT_DRILL_MAPPINGS_V1,
        },
        null,
        2,
      ),
    );
    console.log(
      `drill library v1: ${DRILL_LIBRARY_V1.drills.length} Tier-C drills, ${FAULT_DRILL_MAPPINGS_V1.length} UNVALIDATED mappings → datasets/coach-review/drills/`,
    );
  }
}
