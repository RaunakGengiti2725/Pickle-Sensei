import type { CheckpointKey, FaultDirection } from "@pickle/shared-types";
import {
  correctionPhrase,
  improvementPhrase,
  PERSONAL_BEST_PHRASE,
  REPEAT_PHRASE,
  SETUP_GUIDANCE_PHRASE,
  STABLE_PHRASE,
} from "./phrases.js";

/**
 * Deterministic audio-coach cue selection (directive §25, spec p. 37).
 * Pure state machine: (state, rep) → (decision, nextState).
 * No LLM, no randomness. Cooldowns and silence rules keep it from nagging.
 */

export type CueCategory =
  "CORRECTION" | "IMPROVEMENT" | "PERSONAL_BEST" | "REPEAT" | "STABLE" | "SILENCE";

export interface RepObservation {
  repIndex: number;
  resultKind: "scored" | "low_confidence";
  /** 0–10 overall, null when low confidence. */
  overallScore: number | null;
  focusCheckpoint: CheckpointKey;
  /** 0–100 focus checkpoint score, null when unobserved. */
  focusScore: number | null;
  focusDirection: FaultDirection;
  focusSeverity: number;
}

export interface CueDecision {
  category: CueCategory;
  /** Text for TTS; null exactly when category is SILENCE. */
  text: string | null;
}

export interface CoachState {
  lastSpokenRepIndex: number | null;
  consecutiveCorrections: number;
  lastCorrection: { checkpoint: CheckpointKey; direction: FaultDirection } | null;
  previousFocusScore: number | null;
  previousWasCorrection: boolean;
  lowConfidenceStreak: number;
  bestOverallScore: number | null;
  lastStableRepIndex: number | null;
}

export const INITIAL_COACH_STATE: CoachState = {
  lastSpokenRepIndex: null,
  consecutiveCorrections: 0,
  lastCorrection: null,
  previousFocusScore: null,
  previousWasCorrection: false,
  lowConfidenceStreak: 0,
  bestOverallScore: null,
  lastStableRepIndex: null,
};

export interface CueRules {
  /** Severity at/above which a correction is warranted. */
  correctionSeverity: number;
  /** Severity at/below which a rep counts as stable/good. */
  stableSeverity: number;
  /** Focus-score gain (0–100 scale) that counts as an improvement. */
  improvementDelta: number;
  /** Max corrections in a row before a forced quiet rep. */
  maxConsecutiveCorrections: number;
  /** Minimum reps between STABLE praise cues. */
  stableCooldownReps: number;
  /** Consecutive low-confidence reps before speaking setup guidance. */
  lowConfidenceGuidanceAfter: number;
  /** Reps a personal best must be beyond to be announced (avoids rep-1 spam). */
  personalBestMinRep: number;
}

export const DEFAULT_CUE_RULES: CueRules = {
  correctionSeverity: 0.3,
  stableSeverity: 0.15,
  improvementDelta: 8,
  maxConsecutiveCorrections: 2,
  stableCooldownReps: 4,
  lowConfidenceGuidanceAfter: 3,
  personalBestMinRep: 3,
};

export function selectCue(
  state: CoachState,
  rep: RepObservation,
  rules: CueRules = DEFAULT_CUE_RULES,
): { decision: CueDecision; nextState: CoachState } {
  const next: CoachState = { ...state };

  // --- Low confidence: stay silent, then coach the SETUP, never the stroke.
  if (rep.resultKind === "low_confidence") {
    next.lowConfidenceStreak = state.lowConfidenceStreak + 1;
    next.previousFocusScore = null;
    next.previousWasCorrection = false;
    if (next.lowConfidenceStreak >= rules.lowConfidenceGuidanceAfter) {
      next.lowConfidenceStreak = 0;
      next.lastSpokenRepIndex = rep.repIndex;
      next.consecutiveCorrections = 0;
      return { decision: { category: "CORRECTION", text: SETUP_GUIDANCE_PHRASE }, nextState: next };
    }
    return { decision: { category: "SILENCE", text: null }, nextState: next };
  }

  next.lowConfidenceStreak = 0;

  const isPersonalBest =
    rep.overallScore !== null &&
    state.bestOverallScore !== null &&
    rep.overallScore > state.bestOverallScore &&
    rep.repIndex >= rules.personalBestMinRep;
  if (rep.overallScore !== null) {
    next.bestOverallScore =
      state.bestOverallScore === null
        ? rep.overallScore
        : Math.max(state.bestOverallScore, rep.overallScore);
  }

  const improved =
    state.previousWasCorrection &&
    state.previousFocusScore !== null &&
    rep.focusScore !== null &&
    rep.focusScore - state.previousFocusScore >= rules.improvementDelta;

  next.previousFocusScore = rep.focusScore;

  // --- Personal best beats everything.
  if (isPersonalBest) {
    next.lastSpokenRepIndex = rep.repIndex;
    next.consecutiveCorrections = 0;
    next.previousWasCorrection = false;
    return { decision: { category: "PERSONAL_BEST", text: PERSONAL_BEST_PHRASE }, nextState: next };
  }

  // --- Acknowledge a real improvement on the focus checkpoint.
  if (improved) {
    next.lastSpokenRepIndex = rep.repIndex;
    next.consecutiveCorrections = 0;
    next.previousWasCorrection = false;
    return {
      decision: { category: "IMPROVEMENT", text: improvementPhrase(rep.focusCheckpoint) },
      nextState: next,
    };
  }

  // --- Correction path.
  if (rep.focusSeverity >= rules.correctionSeverity) {
    if (state.consecutiveCorrections >= rules.maxConsecutiveCorrections) {
      // Forced quiet rep — the coach must not become annoying. Clearing the
      // last correction restarts the cycle with a full phrase, not "same issue".
      next.consecutiveCorrections = 0;
      next.previousWasCorrection = true;
      next.lastCorrection = null;
      return { decision: { category: "SILENCE", text: null }, nextState: next };
    }
    const isRepeat =
      state.lastCorrection !== null &&
      state.lastCorrection.checkpoint === rep.focusCheckpoint &&
      state.lastCorrection.direction === rep.focusDirection &&
      state.previousWasCorrection;
    next.lastSpokenRepIndex = rep.repIndex;
    next.consecutiveCorrections = state.consecutiveCorrections + 1;
    next.lastCorrection = { checkpoint: rep.focusCheckpoint, direction: rep.focusDirection };
    next.previousWasCorrection = true;
    if (isRepeat) {
      return { decision: { category: "REPEAT", text: REPEAT_PHRASE }, nextState: next };
    }
    return {
      decision: {
        category: "CORRECTION",
        text: correctionPhrase(rep.focusCheckpoint, rep.focusDirection),
      },
      nextState: next,
    };
  }

  next.consecutiveCorrections = 0;
  next.previousWasCorrection = false;

  // --- Stable/good rep: sparse praise with cooldown; otherwise silence.
  if (rep.focusSeverity <= rules.stableSeverity) {
    const cooledDown =
      state.lastStableRepIndex === null ||
      rep.repIndex - state.lastStableRepIndex >= rules.stableCooldownReps;
    if (cooledDown) {
      next.lastStableRepIndex = rep.repIndex;
      next.lastSpokenRepIndex = rep.repIndex;
      return { decision: { category: "STABLE", text: STABLE_PHRASE }, nextState: next };
    }
  }

  // Technically sound but unremarkable: silence (spec p. 10).
  return { decision: { category: "SILENCE", text: null }, nextState: next };
}
