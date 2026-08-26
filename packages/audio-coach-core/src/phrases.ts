import type { CheckpointKey, FaultDirection } from "@pickle/shared-types";

/**
 * Deterministic cue templates (spec p. 37). No LLM in the live loop.
 * Keys: correction phrases per (checkpoint, direction) with generic fallback.
 */

type PhraseTable = Partial<Record<CheckpointKey, Partial<Record<FaultDirection, string>>>>;

export const CORRECTION_PHRASES: PhraseTable = {
  contact_position: {
    late: "Contact was late. Meet it in front.",
    early: "Contact too far out front. Let it come to you.",
    low: "Contact was low. Take it earlier.",
    high: "Contact was high. Bend and take it lower.",
  },
  preparation: {
    short: "Turn earlier. Get the shoulders set.",
    long: "Over-rotating. Keep the turn compact.",
  },
  swing_length: {
    short: "Lengthen the swing a touch.",
    long: "Big backswing. Keep it compact.",
  },
  paddle_set: {
    low: "Set the paddle higher.",
    high: "Paddle set too high. Relax it down.",
    late: "Set the paddle out front.",
  },
  paddle_path: {
    low: "Swing more low to high.",
    high: "Path too steep. Level it out.",
  },
  athletic_base: {
    narrow: "Widen your base.",
    wide: "Base too wide. Stay athletic.",
    low: "Bend the knees more.",
    high: "Too upright. Get lower.",
  },
  face_wrist_stability: {
    unstable: "Quiet the wrist through contact.",
  },
  sequencing: {
    short: "Let the hips lead.",
    long: "Smooth it out. Body then paddle.",
  },
  follow_through: {
    short: "Finish the swing.",
    long: "Shorten the finish.",
  },
  recovery: {
    long: "Recover faster. Back to ready.",
  },
  ready_position: {
    low: "Paddle up in ready.",
    high: "Relax the paddle to chest height.",
  },
};

export const IMPROVEMENT_PHRASES: Partial<Record<CheckpointKey, string>> = {
  contact_position: "Better — farther in front.",
  preparation: "Better turn. Keep that.",
  swing_length: "Better — more compact.",
  paddle_path: "Better path. Repeat that.",
  face_wrist_stability: "Steadier. Keep it quiet.",
};

export const GENERIC_IMPROVEMENT = "Better. Keep that feel.";
export const PERSONAL_BEST_PHRASE = "That's your best today.";
export const REPEAT_PHRASE = "Same issue. Reset and repeat the cue.";
export const STABLE_PHRASE = "Great rep. Repeat that.";
export const SETUP_GUIDANCE_PHRASE = "Can't read your strokes clearly. Check the camera framing.";

export function correctionPhrase(checkpoint: CheckpointKey, direction: FaultDirection): string {
  const phrase = CORRECTION_PHRASES[checkpoint]?.[direction];
  if (phrase) return phrase;
  return "Focus on your " + checkpoint.replace(/_/g, " ") + ".";
}

export function improvementPhrase(checkpoint: CheckpointKey): string {
  return IMPROVEMENT_PHRASES[checkpoint] ?? GENERIC_IMPROVEMENT;
}
