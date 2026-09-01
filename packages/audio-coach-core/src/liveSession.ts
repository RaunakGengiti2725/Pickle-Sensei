import type { CheckpointKey, FaultDirection } from "@pickle/shared-types";
import { correctionPhrase, improvementPhrase, SETUP_GUIDANCE_PHRASE } from "./phrases.js";
import {
  formatSpokenScore,
  NO_READ_VARIANTS,
  PRAISE_VARIANTS,
  REPEAT_PREFIX,
} from "./livePhrases.js";

/**
 * Talkative "Live Court" cue policy for real-time voice coaching.
 *
 * Unlike the sparse cueEngine (which prefers silence), the live coach speaks
 * after EVERY analyzed swing — including unreadable ones, where it says so
 * honestly. It is still a pure deterministic state machine:
 * (state, rep) → (decision, nextState). No LLM, no randomness; phrase
 * rotation is driven by counters carried in the (JSON-serializable) state.
 */

export type LiveCueCategory =
  | "CORRECTION"
  | "REPEAT_CORRECTION"
  | "IMPROVEMENT"
  | "PERSONAL_BEST"
  | "PRAISE"
  | "NO_READ"
  | "SETUP_GUIDANCE";

export interface LiveCheckpointObservation {
  key: CheckpointKey;
  /** 0–100, null when unobserved this swing. */
  score: number | null;
  direction: FaultDirection;
  /** 0–1 — how far below acceptable this checkpoint is. */
  severity: number;
  applicable: boolean;
}

export interface LiveRepObservation {
  /** 1-based arrival order. */
  repIndex: number;
  kind: "scored" | "low_confidence" | "abstained";
  /** 0–10 overall, one decimal; only present for scored reps. */
  overallScore: number | null;
  checkpoints: readonly LiveCheckpointObservation[];
}

export interface LiveCueDecision {
  category: LiveCueCategory;
  /** Text for TTS. NEVER empty — live mode always speaks. */
  text: string;
  targetCheckpoint: CheckpointKey | null;
  /** The 0–10 score embedded in the text, else null. */
  announcedScore: number | null;
}

export interface LiveCoachSessionState {
  /** Best overall score seen so far (updated on every scored rep). */
  bestOverall: number | null;
  /** What the coach said last — live mode speaks every rep, so this is the previous rep. */
  lastSpoken: {
    category: LiveCueCategory;
    checkpoint: CheckpointKey | null;
    direction: FaultDirection | null;
  } | null;
  /** Previous scored rep's checkpoint scores (for improvement detection). */
  previousCheckpointScores: Record<string, number | null>;
  /** Deterministic rotation index over PRAISE_VARIANTS. */
  praiseCounter: number;
  /** Deterministic rotation index over NO_READ_VARIANTS. */
  noReadCounter: number;
  /** Consecutive unreadable reps (resets on scored reps and setup guidance). */
  noReadStreak: number;
}

export const INITIAL_LIVE_COACH_STATE: LiveCoachSessionState = {
  bestOverall: null,
  lastSpoken: null,
  previousCheckpointScores: {},
  praiseCounter: 0,
  noReadCounter: 0,
  noReadStreak: 0,
};

export interface LiveCueRules {
  /** Worst-checkpoint severity at/above which we correct. */
  correctionSeverity: number;
  /** 0–100 focus-score gain that counts as an improvement. */
  improvementDelta: number;
  /** Personal bests announced only from this rep index. */
  personalBestMinRep: number;
  /** Consecutive no-reads before speaking setup guidance. */
  setupGuidanceAfter: number;
  /** Prefix "6.8. " to correction/praise/improvement lines. */
  announceScores: boolean;
}

export const DEFAULT_LIVE_CUE_RULES: LiveCueRules = {
  correctionSeverity: 0.3,
  improvementDelta: 8,
  personalBestMinRep: 3,
  setupGuidanceAfter: 3,
  announceScores: true,
};

/**
 * Highest-severity applicable checkpoint. Ties break to the lower score
 * (null score counts as 100, i.e. loses ties), then to input order.
 * Returns null only when no checkpoint is applicable.
 */
export function worstCheckpoint(
  checkpoints: readonly LiveCheckpointObservation[],
): LiveCheckpointObservation | null {
  let worst: LiveCheckpointObservation | null = null;
  for (const checkpoint of checkpoints) {
    if (!checkpoint.applicable) continue;
    if (worst === null) {
      worst = checkpoint;
      continue;
    }
    if (checkpoint.severity > worst.severity) {
      worst = checkpoint;
      continue;
    }
    if (checkpoint.severity === worst.severity) {
      const candidateScore = checkpoint.score ?? 100;
      const worstScore = worst.score ?? 100;
      if (candidateScore < worstScore) worst = checkpoint;
    }
  }
  return worst;
}

function lowercaseFirstLetter(text: string): string {
  if (text.length === 0) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function rotate(variants: readonly string[], counter: number, fallback: string): string {
  if (variants.length === 0) return fallback;
  return variants[counter % variants.length] ?? fallback;
}

export function selectLiveCue(
  state: LiveCoachSessionState,
  rep: LiveRepObservation,
  rules: LiveCueRules = DEFAULT_LIVE_CUE_RULES,
): { decision: LiveCueDecision; nextState: LiveCoachSessionState } {
  // --- Unreadable swing: say so honestly; coach the SETUP after a streak.
  if (rep.kind !== "scored") {
    const streak = state.noReadStreak + 1;
    if (streak >= rules.setupGuidanceAfter) {
      const nextState: LiveCoachSessionState = {
        ...state,
        noReadStreak: 0,
        lastSpoken: { category: "SETUP_GUIDANCE", checkpoint: null, direction: null },
      };
      return {
        decision: {
          category: "SETUP_GUIDANCE",
          text: SETUP_GUIDANCE_PHRASE,
          targetCheckpoint: null,
          announcedScore: null,
        },
        nextState,
      };
    }
    const text = rotate(NO_READ_VARIANTS, state.noReadCounter, "No read on that swing.");
    const nextState: LiveCoachSessionState = {
      ...state,
      noReadStreak: streak,
      noReadCounter: state.noReadCounter + 1,
      lastSpoken: { category: "NO_READ", checkpoint: null, direction: null },
    };
    return {
      decision: { category: "NO_READ", text, targetCheckpoint: null, announcedScore: null },
      nextState,
    };
  }

  // --- Scored swing.
  const checkpoints = rep.checkpoints ?? [];
  const worst = worstCheckpoint(checkpoints);

  const isPersonalBest =
    rep.overallScore !== null &&
    state.bestOverall !== null &&
    rep.overallScore > state.bestOverall &&
    rep.repIndex >= rules.personalBestMinRep;

  const last = state.lastSpoken;
  const lastCorrectedCheckpoint =
    last !== null &&
    (last.category === "CORRECTION" || last.category === "REPEAT_CORRECTION") &&
    last.checkpoint !== null
      ? last.checkpoint
      : null;
  let improvedCheckpoint: CheckpointKey | null = null;
  if (lastCorrectedCheckpoint !== null) {
    const previousScore = state.previousCheckpointScores[lastCorrectedCheckpoint];
    const currentScore =
      checkpoints.find((checkpoint) => checkpoint.key === lastCorrectedCheckpoint)?.score ?? null;
    if (
      previousScore !== null &&
      previousScore !== undefined &&
      currentScore !== null &&
      currentScore - previousScore >= rules.improvementDelta
    ) {
      improvedCheckpoint = lastCorrectedCheckpoint;
    }
  }

  const nextState: LiveCoachSessionState = {
    ...state,
    noReadStreak: 0,
    bestOverall:
      rep.overallScore === null
        ? state.bestOverall
        : state.bestOverall === null
          ? rep.overallScore
          : Math.max(state.bestOverall, rep.overallScore),
    previousCheckpointScores: Object.fromEntries(
      checkpoints.map((checkpoint) => [checkpoint.key, checkpoint.score]),
    ),
  };

  const withScorePrefix = (text: string): { text: string; announcedScore: number | null } => {
    if (rules.announceScores && rep.overallScore !== null) {
      return {
        text: `${formatSpokenScore(rep.overallScore)}. ${text}`,
        announcedScore: rep.overallScore,
      };
    }
    return { text, announcedScore: null };
  };

  // --- 1. Personal best beats everything (already carries its score).
  if (isPersonalBest && rep.overallScore !== null) {
    nextState.lastSpoken = { category: "PERSONAL_BEST", checkpoint: null, direction: null };
    return {
      decision: {
        category: "PERSONAL_BEST",
        text: `New best — ${formatSpokenScore(rep.overallScore)}.`,
        targetCheckpoint: null,
        announcedScore: rep.overallScore,
      },
      nextState,
    };
  }

  // --- 2. Acknowledge real improvement on the checkpoint we just corrected.
  if (improvedCheckpoint !== null) {
    const { text, announcedScore } = withScorePrefix(improvementPhrase(improvedCheckpoint));
    nextState.lastSpoken = {
      category: "IMPROVEMENT",
      checkpoint: improvedCheckpoint,
      direction: null,
    };
    return {
      decision: {
        category: "IMPROVEMENT",
        text,
        targetCheckpoint: improvedCheckpoint,
        announcedScore,
      },
      nextState,
    };
  }

  // --- 3. Correction (repeat wording when the same fault persists).
  if (worst !== null && worst.severity >= rules.correctionSeverity) {
    const isRepeat =
      last !== null &&
      (last.category === "CORRECTION" || last.category === "REPEAT_CORRECTION") &&
      last.checkpoint === worst.key &&
      last.direction === worst.direction;
    const phrase = correctionPhrase(worst.key, worst.direction);
    const category: LiveCueCategory = isRepeat ? "REPEAT_CORRECTION" : "CORRECTION";
    const { text, announcedScore } = withScorePrefix(
      isRepeat ? `${REPEAT_PREFIX}${lowercaseFirstLetter(phrase)}` : phrase,
    );
    nextState.lastSpoken = { category, checkpoint: worst.key, direction: worst.direction };
    return {
      decision: { category, text, targetCheckpoint: worst.key, announcedScore },
      nextState,
    };
  }

  // --- 4. Nothing to fix: rotate praise so consecutive clean reps sound alive.
  const { text, announcedScore } = withScorePrefix(
    rotate(PRAISE_VARIANTS, state.praiseCounter, "Great rep. Repeat that."),
  );
  nextState.praiseCounter = state.praiseCounter + 1;
  nextState.lastSpoken = { category: "PRAISE", checkpoint: null, direction: null };
  return {
    decision: { category: "PRAISE", text, targetCheckpoint: null, announcedScore },
    nextState,
  };
}
