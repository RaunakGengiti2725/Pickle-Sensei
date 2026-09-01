/**
 * Phrase material for the talkative "Live Court" policy (see liveSession.ts).
 * The live coach speaks after EVERY analyzed swing, so it needs rotating
 * variety — still fully deterministic (rotation is driven by counters in
 * session state, never randomness).
 */

/** Short praise lines rotated across consecutive clean reps. */
export const PRAISE_VARIANTS: readonly string[] = [
  "Great rep. Repeat that.",
  "Solid swing. Same again.",
  "That's the one. Lock it in.",
  "Clean. Keep that rhythm.",
];

/** Honest lines for a swing the analyzer could not read. */
export const NO_READ_VARIANTS: readonly string[] = [
  "No read on that swing.",
  "Couldn't read that one.",
  "Missed that one — keep swinging.",
];

/** Prefix for a repeated correction; the phrase's first letter is lowercased. */
export const REPEAT_PREFIX = "Still there — ";

/** Spoken when a live coaching session starts. */
export function sessionStartLine(): string {
  return "Live coaching on. I'll call out every swing.";
}

/** One-decimal score string that AVSpeechSynthesizer reads naturally. */
export function formatSpokenScore(score: number): string {
  return score.toFixed(1);
}

/**
 * Honest closing summary. Never exaggerates: no scored swings means saying
 * so, a single scored swing is reported as such, and trends only get called
 * out when both a start and an end average exist.
 */
export function sessionEndLine(input: {
  scoredCount: number;
  startAverage: number | null;
  endAverage: number | null;
  best: number | null;
}): string {
  const { scoredCount, startAverage, endAverage, best } = input;
  if (scoredCount === 0) {
    return "Session over. No swings could be scored this time.";
  }
  if (scoredCount >= 2 && startAverage !== null && endAverage !== null) {
    const start = formatSpokenScore(startAverage);
    const end = formatSpokenScore(endAverage);
    const delta = endAverage - startAverage;
    if (Math.abs(delta) < 0.05) {
      return `Session over. You started around ${start} and finished around ${end} — held steady at ${end}.`;
    }
    const direction = delta > 0 ? "up" : "down";
    return `Session over. You started around ${start} and finished around ${end} — ${direction} ${formatSpokenScore(Math.abs(delta))}.`;
  }
  const single = best ?? startAverage ?? endAverage;
  if (scoredCount === 1 && single !== null) {
    return `Session over. One scored swing at ${formatSpokenScore(single)}.`;
  }
  if (best !== null) {
    return `Session over. Best swing today: ${formatSpokenScore(best)}.`;
  }
  return "Session over. Good work out there.";
}
