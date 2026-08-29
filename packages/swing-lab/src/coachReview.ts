import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./engine/corpus.js";
import { STROKE_TAXONOMY_V3 } from "./strokeHeuristic.js";
import type { StrokeEventLabel, SwingAnnotation } from "./annotationSchema.js";

/**
 * EXPERT COACH REVIEW — the schema and queue for real technique truth.
 *
 *   pnpm lab:coach-queue      # emit review bundles + schema/taxonomy/drill
 *                             # artifacts for the gold StrokeEvents
 *
 * TECHNIQUE SCORING REMAINS BLOCKED_ON_VALIDATION: qualified coach labels
 * are ZERO. This module is the infrastructure that ends that state the
 * legitimate way — structured reviews from real, qualified coaches, multiple
 * per important stroke, with disagreement PRESERVED (never averaged away).
 *
 * Storage contract (append-only):
 *   datasets/coach-review/queue.json                        — derived, regenerated
 *   datasets/coach-review/schema.json                       — derived, regenerated
 *   datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json — derived, regenerated
 *   datasets/coach-review/drills/drill-library.v0.json      — derived, regenerated
 *   datasets/coach-review/coaches.json                      — HUMAN-managed registry;
 *                                                             scaffolded once, never overwritten
 *   datasets/coach-review/reviews/<reviewId>.json           — ONE FILE PER REVIEW,
 *                                                             written only through the
 *                                                             provisioned-coach path,
 *                                                             never edited in place
 *   datasets/coach-review/adjudications/                    — design documented in
 *                                                             docs/COACHING.md (stub)
 *
 * Taxonomy honesty: the fault vocabulary below is a v0 DRAFT for coaches to
 * correct and extend — engineering guesses must not calcify into "truth".
 * Every review records free-text rationale precisely so the real taxonomy
 * can be built FROM coach language. The UI (apps/admin-web) reads the
 * emitted JSON artifacts; docs/COACHING.md is the program handbook.
 */

export const COACH_REVIEW_SCHEMA_VERSION = 2 as const;

/** @deprecated v1 flat seed vocabulary, superseded by FAULT_TAXONOMY_V0_DRAFT
 * (stroke-family-specific, structured). Kept so historical queue.json v1
 * readers and git archaeology stay interpretable. Never referenced by v2. */
export const FAULT_TAXONOMY_V0 = [
  "late_contact",
  "early_contact",
  "contact_too_close_to_body",
  "overreaching_contact",
  "excessive_backswing",
  "insufficient_preparation",
  "no_unit_turn",
  "poor_weight_transfer",
  "off_balance_base",
  "paddle_face_open",
  "paddle_face_closed",
  "wrist_instability",
  "incomplete_follow_through",
  "no_recovery_to_ready",
  "OTHER_SEE_RATIONALE",
] as const;

/* ------------------------------------------------------------------------ *
 * RATING SCALE — explicit anchors (engineering draft, pending coach revision)
 * ------------------------------------------------------------------------ */

export const TECHNIQUE_QUALITY_SCALE_V1 = {
  id: "technique-quality-5pt-v1",
  status: "engineering draft — pending expert validation, will be revised by coaches",
  anchors: {
    1: "Fundamental breakdown: multiple severe faults; the stroke does not accomplish its tactical job.",
    2: "Major fault(s) materially limit the stroke's outcome or repeatability.",
    3: "Functional: identifiable faults, but the stroke accomplishes its job in this context.",
    4: "Strong mechanics: minor refinements only; repeatable under this context's pressure.",
    5: "Model form for this context: could be used as a teaching example.",
  },
} as const;

export const FAULT_SEVERITY_SCALE = {
  1: "minor — visible but unlikely to change the outcome of this ball",
  2: "moderate — costs quality/consistency in this context",
  3: "major — primary reason this stroke fails or breaks down under pressure",
} as const;

/* ------------------------------------------------------------------------ *
 * FAULT TAXONOMY v0-draft — stroke-family-specific, versioned
 * ------------------------------------------------------------------------ */

export const FAULT_TAXONOMY_V0_DRAFT_VERSION = "fault-taxonomy-v0-draft" as const;

export interface FaultDefinition {
  /** Stable id: "<family>.<slug>" — reviews reference this. */
  id: string;
  name: string;
  /** Plain-language description a non-engineer coach can react to. */
  description: string;
  /** What a reviewer can actually point at in video (frames/timestamps). */
  observableEvidence: string;
  /** Typical phase, as a hint for the evidence marker (not enforced). */
  typicalPhase: "preparation" | "acceleration" | "contact" | "follow_through" | "recovery" | "any";
}

export interface FaultFamily {
  /** "global" or a stroke family key from STROKE_FAMILY_BY_V3_LABEL. */
  family: string;
  displayName: string;
  faults: FaultDefinition[];
}

/** v3 recognition label → fault-taxonomy family (relevance per D-031 profiles:
 * shared perception, technique-conditioned interpretation). */
export const STROKE_FAMILY_BY_V3_LABEL: Readonly<Record<string, string>> = {
  FOREHAND_DRIVE: "drive",
  BACKHAND_DRIVE: "drive",
  SERVE: "serve",
  RETURN: "return",
  FOREHAND_DINK: "dink",
  BACKHAND_DINK: "dink",
  FOREHAND_VOLLEY: "volley",
  BACKHAND_VOLLEY: "volley",
  DROP: "drop_reset",
  RESET: "drop_reset",
  OVERHEAD: "overhead",
  SPEEDUP: "speedup",
  UNKNOWN: "global",
};

export const FAULT_TAXONOMY_V0_DRAFT: {
  version: typeof FAULT_TAXONOMY_V0_DRAFT_VERSION;
  status: string;
  strokeTaxonomyVersion: string;
  strokeFamilyByV3Label: Readonly<Record<string, string>>;
  families: FaultFamily[];
} = {
  version: FAULT_TAXONOMY_V0_DRAFT_VERSION,
  status:
    "engineering draft — pending expert validation, will be revised by coaches. " +
    "Ids are stable within v0-draft; coach corrections produce v1 with a recorded mapping.",
  strokeTaxonomyVersion: STROKE_TAXONOMY_V3.version,
  strokeFamilyByV3Label: STROKE_FAMILY_BY_V3_LABEL,
  families: [
    {
      family: "global",
      displayName: "Any stroke",
      faults: [
        {
          id: "global.late_contact",
          name: "Late contact",
          description: "Ball is struck later than intended relative to the body, jamming the stroke.",
          observableEvidence: "At the contact frame the ball is level with or behind the torso midline instead of out front.",
          typicalPhase: "contact",
        },
        {
          id: "global.off_balance_base",
          name: "Off-balance base",
          description: "The base is unstable through the hit; balance, not the ball, becomes the problem.",
          observableEvidence: "Feet still moving at contact, torso lean, stumble or hop immediately after the hit.",
          typicalPhase: "contact",
        },
        {
          id: "global.eyes_off_ball",
          name: "Eyes leave the ball",
          description: "Head/gaze pulls off the contact zone before the ball is struck.",
          observableEvidence: "In the frames before contact the chin/gaze visibly turns toward the target early.",
          typicalPhase: "contact",
        },
        {
          id: "global.no_recovery_to_ready",
          name: "No recovery to ready",
          description: "After the follow-through the player does not return paddle and base to a neutral ready position.",
          observableEvidence: "Paddle hangs low / player static while the opponent strikes the next ball.",
          typicalPhase: "recovery",
        },
        {
          id: "global.other_see_rationale",
          name: "Other (see rationale)",
          description: "Anything the draft vocabulary cannot express. The free-text rationale is the record.",
          observableEvidence: "Cite timestamps in the rationale; this is how the taxonomy grows from coach language.",
          typicalPhase: "any",
        },
      ],
    },
    {
      family: "dink",
      displayName: "Dinks",
      faults: [
        {
          id: "dink.wristy_flick",
          name: "Wristy flick",
          description: "Wrist snaps through contact instead of a stable paddle face pushed from the shoulder.",
          observableEvidence: "Paddle face angle changes rapidly in the frames around contact while the forearm barely moves.",
          typicalPhase: "contact",
        },
        {
          id: "dink.backswing_too_big",
          name: "Backswing too big",
          description: "Take-back exceeds the compact dink envelope, costing control and time.",
          observableEvidence: "Paddle travels behind the hip/torso plane before moving forward.",
          typicalPhase: "preparation",
        },
        {
          id: "dink.standing_tall",
          name: "Standing tall (no leg bend)",
          description: "Player bends at the wrist/back instead of loading the legs to get under the ball.",
          observableEvidence: "Knees near straight at contact on a below-net ball; torso hinges down instead.",
          typicalPhase: "contact",
        },
        {
          id: "dink.contact_not_out_front",
          name: "Contact not out front",
          description: "Ball is played beside or behind the body instead of in front of the front knee.",
          observableEvidence: "At contact the paddle is inside/behind the front knee line.",
          typicalPhase: "contact",
        },
        {
          id: "dink.lifting_trajectory",
          name: "Lifted, attackable trajectory",
          description: "Upward flick sends the ball high over the net where it can be attacked.",
          observableEvidence: "Outgoing arc apexes well above the net tape (visible against the net in frame).",
          typicalPhase: "follow_through",
        },
        {
          id: "dink.paddle_drops_between",
          name: "Paddle drops between dinks",
          description: "Paddle falls below knee height between contacts instead of resetting in front.",
          observableEvidence: "Between dinks the paddle head is visibly below the knees / pointing at the ground.",
          typicalPhase: "recovery",
        },
      ],
    },
    {
      family: "volley",
      displayName: "Volleys",
      faults: [
        {
          id: "volley.takeback_beyond_shoulder",
          name: "Take-back beyond the shoulder",
          description: "Punch volley is wound up like a groundstroke; no time to recover at NVZ pace.",
          observableEvidence: "Paddle drawn behind the shoulder plane before the forward move.",
          typicalPhase: "preparation",
        },
        {
          id: "volley.paddle_below_net_ready",
          name: "Low ready paddle",
          description: "Paddle carried below net height at the NVZ, so high balls arrive before the paddle does.",
          observableEvidence: "Between volleys the paddle head is below the tape while the player is at the line.",
          typicalPhase: "recovery",
        },
        {
          id: "volley.wrist_breakdown",
          name: "Wrist breaks down at contact",
          description: "Wrist collapses under pace; the face flips and the ball leaves off-line.",
          observableEvidence: "Abrupt face-angle change exactly at ball arrival; rebound direction inconsistent with face before contact.",
          typicalPhase: "contact",
        },
        {
          id: "volley.no_split_step",
          name: "No split step",
          description: "Feet are not set when the opponent strikes, so the first move is late.",
          observableEvidence: "Player mid-stride (weight on one foot) at the opponent's contact frame.",
          typicalPhase: "preparation",
        },
        {
          id: "volley.overswing_follow_through",
          name: "Overswing / long follow-through",
          description: "Volley finishes like a drive; compactness is lost and recovery is late.",
          observableEvidence: "Paddle continues far across the body after contact instead of stopping in front.",
          typicalPhase: "follow_through",
        },
        {
          id: "volley.contact_low_late",
          name: "Contact low and late",
          description: "Ball taken beside the torso below net height instead of out front at the highest comfortable point.",
          observableEvidence: "Contact frame shows paddle below tape height and level with the torso.",
          typicalPhase: "contact",
        },
      ],
    },
    {
      family: "drive",
      displayName: "Drives / groundstrokes",
      faults: [
        {
          id: "drive.no_unit_turn",
          name: "No unit turn",
          description: "Shoulders/hips never coil; preparation is arm-only.",
          observableEvidence: "Shoulder line stays square to the net through the backswing.",
          typicalPhase: "preparation",
        },
        {
          id: "drive.late_preparation",
          name: "Late preparation",
          description: "Paddle is not back before the bounce; the swing is rushed.",
          observableEvidence: "Backswing still moving backward at/after the ball's bounce frame.",
          typicalPhase: "preparation",
        },
        {
          id: "drive.arm_only_power",
          name: "Arm-only power",
          description: "Kinetic chain skipped: hips/torso do not rotate into contact.",
          observableEvidence: "Hips visibly static while the arm accelerates; belt buckle never turns toward target.",
          typicalPhase: "acceleration",
        },
        {
          id: "drive.weight_on_back_foot",
          name: "Weight stuck on the back foot",
          description: "Weight moves backward (or never forward) through contact.",
          observableEvidence: "Rear-leaning torso at contact; back foot loaded or stepping away.",
          typicalPhase: "contact",
        },
        {
          id: "drive.open_face_at_contact",
          name: "Open face at contact",
          description: "Paddle face open at impact; ball sails high/long.",
          observableEvidence: "Slow-motion contact frame shows face angled skyward; outgoing flight climbs.",
          typicalPhase: "contact",
        },
        {
          id: "drive.incomplete_follow_through",
          name: "Incomplete follow-through",
          description: "Swing decelerates into/at contact instead of finishing across the body.",
          observableEvidence: "Paddle stops shortly after the contact frame; no finish over shoulder/across torso.",
          typicalPhase: "follow_through",
        },
      ],
    },
    {
      family: "overhead",
      displayName: "Overheads",
      faults: [
        {
          id: "overhead.no_sideways_turn",
          name: "No sideways turn",
          description: "Body stays square to the net; the overhead becomes an arm wave.",
          observableEvidence: "Chest faces the net for the whole motion; no hip/shoulder line rotation sideways.",
          typicalPhase: "preparation",
        },
        {
          id: "overhead.ball_drifts_behind",
          name: "Ball drifts behind the head",
          description: "Contact point ends up behind the head instead of up-and-slightly-in-front.",
          observableEvidence: "At contact the ball is above/behind the head plane; back arches to reach it.",
          typicalPhase: "contact",
        },
        {
          id: "overhead.dropped_elbow",
          name: "Dropped elbow",
          description: "Hitting elbow collapses below the shoulder before acceleration; power and reach are lost.",
          observableEvidence: "Elbow visibly below the shoulder line as the paddle starts forward.",
          typicalPhase: "acceleration",
        },
        {
          id: "overhead.no_offhand_tracking",
          name: "No off-hand tracking",
          description: "Non-paddle arm never points at / tracks the lob, so spacing is a guess.",
          observableEvidence: "Off arm hangs at the side during the setup instead of raising toward the ball.",
          typicalPhase: "preparation",
        },
        {
          id: "overhead.no_feet_under_ball",
          name: "Feet never get under the ball",
          description: "Player reaches from where they stand instead of repositioning under the lob.",
          observableEvidence: "Zero adjustment steps between the lob going up and the swing.",
          typicalPhase: "preparation",
        },
        {
          id: "overhead.off_balance_landing",
          name: "Off-balance landing",
          description: "Player falls backward/sideways after the smash and cannot play the next ball.",
          observableEvidence: "Backward stumble or hop after contact; no balanced landing.",
          typicalPhase: "recovery",
        },
      ],
    },
    {
      family: "serve",
      displayName: "Serves (technique only — legality is Serve Check, a separate concept)",
      faults: [
        {
          id: "serve.inconsistent_drop_toss",
          name: "Inconsistent drop/toss",
          description: "Ball release point wanders serve to serve, so contact must chase it.",
          observableEvidence: "Across serves the release/drop point visibly differs relative to the stance.",
          typicalPhase: "preparation",
        },
        {
          id: "serve.arm_only_no_legs",
          name: "Arm-only serve",
          description: "No leg drive or weight transfer; all pace comes from the shoulder.",
          observableEvidence: "Hips static, back foot never releases through the strike.",
          typicalPhase: "acceleration",
        },
        {
          id: "serve.no_unit_turn",
          name: "No unit turn",
          description: "Shoulders/hips do not coil during preparation.",
          observableEvidence: "Shoulder line square to the target through the whole motion.",
          typicalPhase: "preparation",
        },
        {
          id: "serve.rushed_motion",
          name: "Rushed motion",
          description: "No settled routine; the serve is hit hurried and off-rhythm.",
          observableEvidence: "Almost no pause between setup and strike; off-balance finish.",
          typicalPhase: "preparation",
        },
        {
          id: "serve.contact_point_wanders",
          name: "Contact point wanders",
          description: "Contact varies between out-front and beside-the-hip across serves.",
          observableEvidence: "Comparing serve contact frames shows widely different paddle/ball positions.",
          typicalPhase: "contact",
        },
        {
          id: "serve.incomplete_follow_through",
          name: "Incomplete follow-through",
          description: "Motion decelerates at contact instead of finishing toward the target.",
          observableEvidence: "Paddle stops near waist height right after contact.",
          typicalPhase: "follow_through",
        },
      ],
    },
    {
      family: "return",
      displayName: "Returns",
      faults: [
        {
          id: "return.no_split_at_serve",
          name: "No split step at serve contact",
          description: "Returner is flat-footed or mid-stride when the serve is struck.",
          observableEvidence: "At the server's contact frame the returner's feet are not set/split.",
          typicalPhase: "preparation",
        },
        {
          id: "return.overswing_on_pace",
          name: "Overswing against pace",
          description: "Full groundstroke swing against a fast serve instead of a compact block/drive.",
          observableEvidence: "Long take-back past the torso plane against a visibly fast serve.",
          typicalPhase: "preparation",
        },
        {
          id: "return.jammed_contact",
          name: "Jammed contact",
          description: "Body not cleared; the ball plays the returner at the hip/torso.",
          observableEvidence: "Elbow pinned against the torso at contact; no space between body and paddle.",
          typicalPhase: "contact",
        },
        {
          id: "return.no_forward_transition",
          name: "No forward transition",
          description: "Returner stays parked at the baseline after the return instead of advancing.",
          observableEvidence: "Several frames after contact the returner has not started moving up-court.",
          typicalPhase: "recovery",
        },
      ],
    },
    {
      family: "drop_reset",
      displayName: "Drops / resets",
      faults: [
        {
          id: "drop.overpowered_arc",
          name: "Overpowered arc",
          description: "Drop is driven flat/deep instead of apexing on the hitter's side and dying in the kitchen.",
          observableEvidence: "Ball apex occurs at/beyond the net plane; landing deep past the NVZ.",
          typicalPhase: "follow_through",
        },
        {
          id: "drop.wrist_scoop",
          name: "Wrist scoop",
          description: "Wrist scoops the lift instead of a stable face lifted from shoulder/legs.",
          observableEvidence: "Face angle rotates through contact; wrist visibly hinges upward.",
          typicalPhase: "contact",
        },
        {
          id: "drop.no_leg_lift",
          name: "No leg lift",
          description: "All arm on the lift; legs never load, so height control is inconsistent.",
          observableEvidence: "Knees straight through the lift on a low ball.",
          typicalPhase: "acceleration",
        },
        {
          id: "reset.stiff_hands",
          name: "Stiff hands on the reset",
          description: "Punching at a defensive reset instead of absorbing pace with soft hands.",
          observableEvidence: "Paddle moves forward into the ball on a defensive reset; rebound too hot.",
          typicalPhase: "contact",
        },
      ],
    },
    {
      family: "speedup",
      displayName: "Speed-ups / attacks",
      faults: [
        {
          id: "speedup.telegraphed_windup",
          name: "Telegraphed wind-up",
          description: "Attack is announced by a visibly different preparation than the dink pattern.",
          observableEvidence: "Distinct pause/backswing before the attack that did not exist on previous dinks.",
          typicalPhase: "preparation",
        },
        {
          id: "speedup.attack_from_below_net",
          name: "Attack initiated below net height",
          description: "Speed-up attempted on a ball below the tape — low-percentage, rises into counters.",
          observableEvidence: "Contact frame shows the ball clearly below net height at initiation.",
          typicalPhase: "contact",
        },
        {
          id: "speedup.no_reset_after_attack",
          name: "No reset after the attack",
          description: "Player admires the speed-up instead of returning to ready for the counter.",
          observableEvidence: "Paddle/base not back to neutral by the opponent's counter contact.",
          typicalPhase: "recovery",
        },
      ],
    },
  ],
};

export function faultIdsForStroke(v3Label: string | null): {
  relevantFamilies: string[];
  faultIds: string[];
} {
  const family = v3Label ? (STROKE_FAMILY_BY_V3_LABEL[v3Label] ?? "global") : "global";
  const relevantFamilies = family === "global" ? ["global"] : ["global", family];
  const faultIds = FAULT_TAXONOMY_V0_DRAFT.families
    .filter((entry) => relevantFamilies.includes(entry.family))
    .flatMap((entry) => entry.faults.map((fault) => fault.id));
  return { relevantFamilies, faultIds };
}

export function allFaultIds(): string[] {
  return FAULT_TAXONOMY_V0_DRAFT.families.flatMap((entry) => entry.faults.map((fault) => fault.id));
}

/* ------------------------------------------------------------------------ *
 * DRILL LIBRARY v0 — structure only; validated mappings REQUIRE coach evidence
 * ------------------------------------------------------------------------ */

export const DRILL_LIBRARY_V0_VERSION = "drill-library-v0" as const;

export interface DrillEntry {
  id: string;
  name: string;
  /** v3 recognition labels this drill practices. */
  supportedTechniques: string[];
  /** faultId → evidence refs. EMPTY until real coach reviews justify a mapping. */
  validatedFaultMappings: Array<{ faultId: string; evidence: string[] }>;
  description: string;
  difficulty: "beginner" | "intermediate" | "advanced";
  equipment: string[];
  repsOrDuration: string;
  progressions: string[];
  regressions: string[];
  /** null until a qualified coach endorses/authors the entry. */
  coachProvenance: null | { coachId: string; credentialRef: string; endorsedAtIso: string };
  /** Where the entry actually came from, stated plainly. */
  provenance: string;
  validationStatus: "UNVALIDATED" | "COACH_VALIDATED";
  mediaRefs: string[];
  version: typeof DRILL_LIBRARY_V0_VERSION;
}

export const DRILL_LIBRARY_V0: {
  version: typeof DRILL_LIBRARY_V0_VERSION;
  status: string;
  drills: DrillEntry[];
} = {
  version: DRILL_LIBRARY_V0_VERSION,
  status:
    "schema + two well-known public drills as UNVALIDATED placeholders. " +
    "validatedFaultMappings stay EMPTY until coach reviews supply evidence; " +
    "nothing here may be recommended to users.",
  drills: [
    {
      id: "drill.wall-dink-rally",
      name: "Wall dink rally",
      supportedTechniques: ["FOREHAND_DINK", "BACKHAND_DINK"],
      validatedFaultMappings: [],
      description:
        "Continuous soft dinks against a practice wall with a net-height line; keep every contact out front with a stable face.",
      difficulty: "beginner",
      equipment: ["paddle", "ball", "wall with net-height line (34 in)"],
      repsOrDuration: "3 × 2 min continuous rally",
      progressions: ["alternate forehand/backhand each contact", "target box 6–12 in above the line"],
      regressions: ["allow one bounce between contacts", "stand closer to the wall"],
      coachProvenance: null,
      provenance: "engineering placeholder — well-known public drill; NOT coach-validated",
      validationStatus: "UNVALIDATED",
      mediaRefs: [],
      version: DRILL_LIBRARY_V0_VERSION,
    },
    {
      id: "drill.skinny-singles",
      name: "Skinny singles",
      supportedTechniques: ["SERVE", "RETURN", "FOREHAND_DRIVE", "BACKHAND_DRIVE", "DROP", "FOREHAND_DINK", "BACKHAND_DINK"],
      validatedFaultMappings: [],
      description:
        "Half-court singles (straight or crosscourt halves): full point play with less court to cover, concentrating reps on serve, return, third shot and kitchen play.",
      difficulty: "intermediate",
      equipment: ["paddle", "ball", "court"],
      repsOrDuration: "games to 7, switch halves",
      progressions: ["crosscourt halves only (longer diagonal)", "third shot must be a drop"],
      regressions: ["serve-and-return only, replay the point after the 4th ball"],
      coachProvenance: null,
      provenance: "engineering placeholder — well-known public drill; NOT coach-validated",
      validationStatus: "UNVALIDATED",
      mediaRefs: [],
      version: DRILL_LIBRARY_V0_VERSION,
    },
  ],
};

/* ------------------------------------------------------------------------ *
 * REVIEW RECORD v2 — one append-only file per review
 * ------------------------------------------------------------------------ */

export interface CoachReview {
  schemaVersion: typeof COACH_REVIEW_SCHEMA_VERSION;
  /** `${queueItemId}.${coachId}` — also the filename stem; enforces one
   * review per coach per queue item and append-only storage. */
  reviewId: string;
  /** e.g. "wm-dink-01-E1" (caseId + 1-based event ordinal). */
  queueItemId: string;
  /** Opaque pseudonymous id provisioned in coaches.json; PII stays off-repo. */
  coachId: string;
  /** Opaque reference to the off-repo credential record (e.g. "cred-2026-004"). */
  coachCredentialRef: string;
  eventRef: { caseId: string; eventIndex: number };
  strokeTaxonomyVersion: string;
  faultTaxonomyVersion: string;
  drillLibraryVersion: string | null;
  /** Confirm/correct the stroke type, or decline honestly. */
  strokeConfirmation:
    | { kind: "confirmed"; stroke: string }
    | { kind: "corrected"; stroke: string; note: string }
    | { kind: "cannot_judge"; reason: string };
  /** Anchored 1–5 (TECHNIQUE_QUALITY_SCALE_V1); null when not assessable. */
  overallQuality: { scaleId: typeof TECHNIQUE_QUALITY_SCALE_V1.id; value: 1 | 2 | 3 | 4 | 5 } | null;
  /** Structured faults; order = coach's priority order (first = primary). */
  faults: Array<{
    faultId: string;
    severity: 1 | 2 | 3;
    evidence: {
      /** Video timestamps (ms, source-video timeline) the coach marked. */
      timestampsMs: number[];
      /** Optional normalized region (x,y,w,h in 0..1) if the coach marked one. */
      region: { x: number; y: number; w: number; h: number } | null;
    };
    /** Per-fault prose — the signal the real taxonomy will be built from. */
    rationale: string;
  }>;
  /** Suggestions only. drillId may reference the UNVALIDATED library or be
   * null with free text; suggestions are seeds, never recommendations. */
  drillSuggestions: Array<{ drillId: string | null; freeText: string }>;
  /** The coach's own confidence in this review, 0..1. */
  confidence: number;
  /** First-class honest outcome; when set, quality/faults may be empty. */
  cannotEvaluate: { reason: string } | null;
  /** Review-level prose (mandatory unless cannotEvaluate). */
  rationale: string;
  createdAtIso: string;
  submittedAtIso: string;
}

export function queueItemIdFor(caseId: string, eventIndex: number): string {
  return `${caseId}-E${eventIndex + 1}`;
}

export function reviewIdFor(queueItemId: string, coachId: string): string {
  return `${queueItemId}.${coachId}`;
}

const COACH_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

export function validateCoachReview(
  raw: unknown,
  context?: {
    knownQueueItemIds?: string[];
    knownFaultIds?: string[];
    knownDrillIds?: string[];
  },
): string[] {
  const problems: string[] = [];
  const review = raw as Partial<CoachReview> | null;
  if (!review || typeof review !== "object") return ["review must be an object"];
  if (review.schemaVersion !== COACH_REVIEW_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${COACH_REVIEW_SCHEMA_VERSION}`);
  }
  if (!review.coachId || !COACH_ID_PATTERN.test(review.coachId)) {
    problems.push("coachId required (opaque id, 2-64 chars [a-z0-9_-])");
  }
  if (review.coachId && /synthetic/i.test(review.coachId)) {
    problems.push("SYNTHETIC coach ids are dev fixtures and may never be persisted");
  }
  if (!review.coachCredentialRef || typeof review.coachCredentialRef !== "string") {
    problems.push("coachCredentialRef required (opaque credential record reference)");
  }
  if (!review.queueItemId) problems.push("queueItemId required");
  if (context?.knownQueueItemIds && review.queueItemId && !context.knownQueueItemIds.includes(review.queueItemId)) {
    problems.push(`queueItemId ${review.queueItemId} not in the current queue`);
  }
  if (review.queueItemId && review.coachId && review.reviewId !== reviewIdFor(review.queueItemId, review.coachId)) {
    problems.push("reviewId must equal `${queueItemId}.${coachId}`");
  }
  if (!review.eventRef?.caseId || typeof review.eventRef.eventIndex !== "number") {
    problems.push("eventRef {caseId, eventIndex} required");
  } else if (review.queueItemId && queueItemIdFor(review.eventRef.caseId, review.eventRef.eventIndex) !== review.queueItemId) {
    problems.push("eventRef must resolve to queueItemId");
  }
  if (review.strokeTaxonomyVersion !== STROKE_TAXONOMY_V3.version) {
    problems.push(`strokeTaxonomyVersion must be ${STROKE_TAXONOMY_V3.version}`);
  }
  if (review.faultTaxonomyVersion !== FAULT_TAXONOMY_V0_DRAFT_VERSION) {
    problems.push(`faultTaxonomyVersion must be ${FAULT_TAXONOMY_V0_DRAFT_VERSION}`);
  }
  const confirmation = review.strokeConfirmation as CoachReview["strokeConfirmation"] | undefined;
  if (!confirmation) problems.push("strokeConfirmation required");
  else if (confirmation.kind === "cannot_judge") {
    if (!confirmation.reason || confirmation.reason.trim().length < 5) {
      problems.push("strokeConfirmation.cannot_judge requires a reason");
    }
  } else {
    const labels = STROKE_TAXONOMY_V3.labels as readonly string[];
    if (!labels.includes(confirmation.stroke)) {
      problems.push(`stroke ${confirmation.stroke} not in ${STROKE_TAXONOMY_V3.version}`);
    }
    if (confirmation.kind === "corrected" && (!confirmation.note || confirmation.note.trim().length < 5)) {
      problems.push("corrected stroke requires a note");
    }
  }
  const cannotEvaluate = review.cannotEvaluate;
  if (cannotEvaluate !== null && cannotEvaluate !== undefined) {
    if (!cannotEvaluate.reason || cannotEvaluate.reason.trim().length < 10) {
      problems.push("cannotEvaluate.reason required (≥10 chars)");
    }
  } else if (cannotEvaluate === undefined) {
    problems.push("cannotEvaluate must be present (null or {reason}) — it is a first-class outcome");
  }
  const quality = review.overallQuality;
  if (quality !== null && quality !== undefined) {
    if (quality.scaleId !== TECHNIQUE_QUALITY_SCALE_V1.id) problems.push(`overallQuality.scaleId must be ${TECHNIQUE_QUALITY_SCALE_V1.id}`);
    if (![1, 2, 3, 4, 5].includes(quality.value)) problems.push("overallQuality.value must be 1..5");
  } else if (quality === undefined) {
    problems.push("overallQuality must be present (null or anchored value)");
  }
  if (!cannotEvaluate && quality === null && (review.faults?.length ?? 0) === 0) {
    problems.push("a review without cannotEvaluate must carry overallQuality and/or faults");
  }
  if (!Array.isArray(review.faults)) problems.push("faults[] required (may be empty)");
  else {
    for (const [index, fault] of review.faults.entries()) {
      if (!fault.faultId) problems.push(`faults[${index}].faultId required`);
      else if (context?.knownFaultIds && !context.knownFaultIds.includes(fault.faultId)) {
        problems.push(`faults[${index}].faultId ${fault.faultId} not in ${FAULT_TAXONOMY_V0_DRAFT_VERSION}`);
      }
      if (![1, 2, 3].includes(fault.severity as number)) problems.push(`faults[${index}].severity must be 1..3`);
      if (!fault.evidence || !Array.isArray(fault.evidence.timestampsMs) || fault.evidence.timestampsMs.length === 0) {
        problems.push(`faults[${index}].evidence.timestampsMs requires ≥1 video timestamp`);
      } else if (fault.evidence.timestampsMs.some((t) => typeof t !== "number" || !Number.isFinite(t) || t < 0)) {
        problems.push(`faults[${index}].evidence.timestampsMs must be non-negative ms numbers`);
      }
      const region = fault.evidence?.region;
      if (region !== null && region !== undefined) {
        const values = [region.x, region.y, region.w, region.h];
        if (values.some((v) => typeof v !== "number" || v < 0 || v > 1)) {
          problems.push(`faults[${index}].evidence.region must be normalized 0..1 {x,y,w,h}`);
        }
      }
      if (!fault.rationale || fault.rationale.trim().length < 10) {
        problems.push(`faults[${index}].rationale required (≥10 chars)`);
      }
    }
  }
  if (!Array.isArray(review.drillSuggestions)) problems.push("drillSuggestions[] required (may be empty)");
  else {
    for (const [index, suggestion] of review.drillSuggestions.entries()) {
      if (suggestion.drillId !== null && context?.knownDrillIds && !context.knownDrillIds.includes(suggestion.drillId)) {
        problems.push(`drillSuggestions[${index}].drillId ${suggestion.drillId} not in ${DRILL_LIBRARY_V0_VERSION}`);
      }
      if (suggestion.drillId === null && (!suggestion.freeText || suggestion.freeText.trim().length < 5)) {
        problems.push(`drillSuggestions[${index}] needs a drillId or free text`);
      }
    }
  }
  if (typeof review.confidence !== "number" || review.confidence < 0 || review.confidence > 1) {
    problems.push("confidence must be 0..1");
  }
  if (!cannotEvaluate && (typeof review.rationale !== "string" || review.rationale.trim().length < 20)) {
    problems.push("rationale required (≥20 chars — the prose is the signal)");
  }
  for (const field of ["createdAtIso", "submittedAtIso"] as const) {
    const value = review[field];
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) problems.push(`${field} must be an ISO timestamp`);
  }
  return problems;
}

/* ------------------------------------------------------------------------ *
 * CLI — regenerate queue + derived artifacts (never fabricates reviews)
 * ------------------------------------------------------------------------ */

const isMain = process.argv[1]?.endsWith("coachReview.ts");
if (isMain) {
  const PB = join(REPO_ROOT, "datasets/paddle-bench");
  const bench = (JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: Array<{ id: string; video: string; labels: string; role?: string }>;
  }).cases;
  const outDir = join(REPO_ROOT, "datasets/coach-review");
  const reviewsDir = join(outDir, "reviews");
  mkdirSync(reviewsDir, { recursive: true });
  mkdirSync(join(outDir, "taxonomy"), { recursive: true });
  mkdirSync(join(outDir, "drills"), { recursive: true });

  /** Real review files on disk (append-only dir) — the ONLY source of
   * existingReviews. This tool never writes into reviews/. */
  const reviewFiles = readdirSync(reviewsDir).filter((name) => name.endsWith(".json"));
  const reviewsByItem = new Map<string, string[]>();
  for (const file of reviewFiles) {
    const stem = file.replace(/\.json$/, "");
    const itemId = stem.slice(0, stem.lastIndexOf("."));
    reviewsByItem.set(itemId, [...(reviewsByItem.get(itemId) ?? []), `datasets/coach-review/reviews/${file}`]);
  }

  const queue: object[] = [];
  for (const benchCase of bench) {
    const annotation = JSON.parse(readFileSync(resolve(PB, benchCase.labels), "utf8")) as SwingAnnotation & {
      eventLabels?: StrokeEventLabel[];
      annotatedStrokeV3?: string;
    };
    for (const [index, event] of (annotation.eventLabels ?? []).entries()) {
      if (event.owner !== "target") continue;
      const queueItemId = queueItemIdFor(benchCase.id, index);
      const stroke = annotation.annotatedStrokeV3 ?? null;
      const { relevantFamilies } = faultIdsForStroke(stroke);
      queue.push({
        queueItemId,
        eventRef: { caseId: benchCase.id, eventIndex: index },
        video: `datasets/paddle-bench/${benchCase.video}`,
        windowMs: { start: event.eventStartMs, end: event.eventEndMs },
        contactMs: event.contactMs,
        annotatedStrokeV3: stroke,
        strokeFamily: stroke ? (STROKE_FAMILY_BY_V3_LABEL[stroke] ?? "global") : "global",
        relevantFaultFamilies: relevantFamilies,
        bundle: {
          role: benchCase.role ?? "development",
          annotatorId: annotation.annotatorId,
          revision: annotation.revision,
          analyzable: annotation.analyzable,
          notAnalyzableReason: annotation.notAnalyzableReason,
          annotatorConfidence: annotation.annotatorConfidence,
          contactUncertainty: annotation.contactUncertainty ?? null,
          phases: annotation.phases,
          eventNote: event.note ?? null,
        },
        replayCommand: `ffplay -ss ${(Math.max(0, event.eventStartMs - 800) / 1000).toFixed(2)} -t ${((event.eventEndMs - event.eventStartMs + 1600) / 1000).toFixed(2)} datasets/paddle-bench/${benchCase.video}`,
        reviewTemplate: `datasets/coach-review/reviews/${queueItemId}.<coachId>.json`,
        requiredReviewsTarget: 2,
        existingReviews: reviewsByItem.get(queueItemId) ?? [],
      });
    }
  }

  const manifest = {
    schemaVersion: COACH_REVIEW_SCHEMA_VERSION,
    generatedAtIso: new Date().toISOString(),
    status:
      "AWAITING QUALIFIED COACHES — 0 reviews exist; technique scoring stays BLOCKED_ON_VALIDATION until real coach labels arrive and agree",
    program: {
      reviewersPerStroke: "≥2 independent qualified coaches for important strokes",
      disagreementPolicy: "preserved as data; adjudication recorded separately; never averaged away",
      taxonomyPolicy: `${allFaultIds().length}-fault ${FAULT_TAXONOMY_V0_DRAFT_VERSION} (stroke-family-specific) expected to be corrected/extended by coaches; rationale prose is mandatory so the real taxonomy grows from coach language`,
      agreementMetrics: "stroke confirmation %, rating exact/|Δ|, primary-fault agreement, severity agreement, fault-set overlap",
      onboarding: "docs/COACHING.md",
      reviewConsole: "apps/admin-web (pnpm --filter @pickle/admin-web dev → Coach Review Lab)",
    },
    artifacts: {
      schema: "datasets/coach-review/schema.json",
      faultTaxonomy: "datasets/coach-review/taxonomy/fault-taxonomy.v0-draft.json",
      drillLibrary: "datasets/coach-review/drills/drill-library.v0.json",
      coachRegistry: "datasets/coach-review/coaches.json",
      reviewsDir: "datasets/coach-review/reviews/",
    },
    queue,
  };
  writeFileSync(join(outDir, "queue.json"), JSON.stringify(manifest, null, 2));

  const schemaDescriptor = {
    schemaVersion: COACH_REVIEW_SCHEMA_VERSION,
    generatedAtIso: manifest.generatedAtIso,
    reviewRecord: {
      typescriptSource: "packages/swing-lab/src/coachReview.ts (interface CoachReview + validateCoachReview)",
      storage: "datasets/coach-review/reviews/<reviewId>.json — append-only; one file per review; never edited in place",
      reviewIdRule: "`${queueItemId}.${coachId}`; one review per coach per queue item",
      requiredFields: [
        "schemaVersion", "reviewId", "queueItemId", "coachId", "coachCredentialRef", "eventRef",
        "strokeTaxonomyVersion", "faultTaxonomyVersion", "drillLibraryVersion", "strokeConfirmation",
        "overallQuality", "faults", "drillSuggestions", "confidence", "cannotEvaluate", "rationale",
        "createdAtIso", "submittedAtIso",
      ],
    },
    strokeTaxonomy: { version: STROKE_TAXONOMY_V3.version, labels: STROKE_TAXONOMY_V3.labels },
    qualityScale: TECHNIQUE_QUALITY_SCALE_V1,
    severityScale: FAULT_SEVERITY_SCALE,
    confidenceSemantics: "coach's own 0..1 confidence in this review; not a model output",
    cannotEvaluateSemantics: "first-class outcome: honest refusal with reason; quality/faults may be empty",
    faultTaxonomyVersion: FAULT_TAXONOMY_V0_DRAFT_VERSION,
    drillLibraryVersion: DRILL_LIBRARY_V0_VERSION,
  };
  writeFileSync(join(outDir, "schema.json"), JSON.stringify(schemaDescriptor, null, 2));
  writeFileSync(
    join(outDir, "taxonomy", "fault-taxonomy.v0-draft.json"),
    JSON.stringify({ generatedAtIso: manifest.generatedAtIso, ...FAULT_TAXONOMY_V0_DRAFT }, null, 2),
  );
  writeFileSync(
    join(outDir, "drills", "drill-library.v0.json"),
    JSON.stringify({ generatedAtIso: manifest.generatedAtIso, ...DRILL_LIBRARY_V0 }, null, 2),
  );

  /** Coach registry is HUMAN-managed: scaffold once, never overwrite. */
  const registryPath = join(outDir, "coaches.json");
  if (!existsSync(registryPath)) {
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          note:
            "HUMAN-managed registry. Provisioning a real coach (docs/COACHING.md §2) means appending " +
            "{coachId, credentialRef, status:'active', provisionedAtIso, provisionedBy} here in a reviewed " +
            "commit. coachId is opaque/pseudonymous; credentials + PII stay OFF-REPO behind credentialRef. " +
            "This file is never written by tooling and MUST NOT contain synthetic/demo identities.",
          coaches: [],
        },
        null,
        2,
      ),
    );
  }

  console.log(`coach review queue: ${queue.length} gold StrokeEvents → datasets/coach-review/queue.json`);
  console.log(
    `derived artifacts: schema.json · taxonomy/fault-taxonomy.v0-draft.json (${allFaultIds().length} faults, ${FAULT_TAXONOMY_V0_DRAFT.families.length} families) · drills/drill-library.v0.json (${DRILL_LIBRARY_V0.drills.length} UNVALIDATED placeholders)`,
  );
  console.log(`reviews on file: ${reviewFiles.length} (schema + queue ready; recruitment is a human step)`);
  if (!existsSync(join(outDir, "reviews"))) process.exitCode = 1;
}
