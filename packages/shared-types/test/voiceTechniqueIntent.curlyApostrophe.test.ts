import { describe, expect, it } from "vitest";
import { resolveVoiceTechniqueIntent } from "../src/voiceTechniqueIntent.js";

/**
 * Reproduction (stress area components-3, seeds 3541865743 / 1417414519):
 * iOS smart punctuation and dictation emit U+2019 (’) for every apostrophe.
 * `normalize()` replaces U+2019 with a space, so "don’t" becomes "don t" and
 * every contraction-based cue (NEGATION_CUES `don'?t|doesn'?t|won'?t`,
 * AUTO_PATTERN `don'?t know`) silently stops matching. A typed-apostrophe
 * transcript and its curly twin must resolve identically.
 */
const TWINS: ReadonlyArray<readonly [ascii: string, curly: string]> = [
  ["don't want the forehand drive", "don\u2019t want the forehand drive"],
  ["doesn't need the backhand dink", "doesn\u2019t need the backhand dink"],
  ["won't do the serve", "won\u2019t do the serve"],
  ["I don't know", "I don\u2019t know"],
  ["don't know", "don\u2019t know"],
];

describe("resolveVoiceTechniqueIntent — curly apostrophe (U+2019) parity", () => {
  for (const [ascii, curly] of TWINS) {
    it(`resolves ${JSON.stringify(curly)} exactly like ${JSON.stringify(ascii)}`, () => {
      expect(resolveVoiceTechniqueIntent(curly)).toEqual(resolveVoiceTechniqueIntent(ascii));
    });
  }

  it("never commits a negated technique spoken with a curly apostrophe", () => {
    const resolution = resolveVoiceTechniqueIntent("don\u2019t want the forehand drive");
    expect(resolution.status).not.toBe("leaf");
  });

  it("treats a curly-apostrophe 'don’t know' as the auto intent", () => {
    expect(resolveVoiceTechniqueIntent("I don\u2019t know").status).toBe("auto");
  });
});
