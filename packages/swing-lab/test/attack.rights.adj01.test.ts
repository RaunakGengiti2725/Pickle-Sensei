/**
 * Adversarial probes for the pkg-swing-lab::ADJ-01 fix (448510ce) — the
 * `?` / TBD / TODO hedge markers and the NC redistribute change in
 * engine/rights.ts. Each block below FAILS on 448510ce and documents a
 * deterministic gap in the changed code; none of them weakens an existing pin.
 *
 * Plane: Linux bench.
 */
import { describe, expect, it } from "vitest";
import { rightsForLicense, trainingEligible } from "../src/engine/rights.js";

const REVIEWER = "attack-probe";

const MODALITIES = [
  "store",
  "analyze",
  "annotate",
  "train",
  "redistributeDerivatives",
  "commercial",
] as const;

describe("ADJ-01 attack: the new question-mark hedge only sees ASCII '?'", () => {
  // The fix pins "CC BY 4.0?" and "Public domain (?)" as all-unclear ("a
  // question mark ... is a reviewer who has not decided"). The same reviewer
  // typing on a CJK keyboard, or pasting from a rich-text note, produces a
  // Unicode question mark that the marker does not recognise, so the
  // undecided string keeps its full affirmative profile and is
  // training-eligible.
  for (const license of [
    "CC BY 4.0\uFF1F", // FULLWIDTH QUESTION MARK
    "CC BY 4.0 \u2047", // DOUBLE QUESTION MARK
    "CC BY-SA 4.0 \u2048", // QUESTION EXCLAMATION MARK
    "CC BY 4.0 \u203D", // INTERROBANG
    "Public domain\uFF1F",
    "CC0 \u2047",
  ]) {
    it(`${JSON.stringify(license)} is quarantined like its ASCII twin`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      for (const modality of MODALITIES) {
        expect(rights[modality], `${license} → ${modality}`).toBe("unclear");
      }
      expect(trainingEligible(rights)).toBe(false);
    });
  }
});

describe("ADJ-01 attack: a '?' inside a licenseurl query string is not a hedge", () => {
  // audit.structural.rights.test.ts pins that restating the designation's own
  // licenseurl keeps the profile ("CC BY-SA 4.0 (item licenseurl field reads
  // verbatim: https://creativecommons.org/licenses/by-sa/4.0/)"). The URL the
  // Creative Commons chooser emits carries `?ref=chooser-v1`; on f702f0f8 the
  // string below derives the same profile as its query-less twin, on 448510ce
  // the bare `\?` marker turns it all-unclear (a fail-closed regression: a
  // recognised, unhedged designation is sent to human review).
  const pairs: ReadonlyArray<readonly [string, string]> = [
    [
      "CC BY 4.0 (licenseurl: https://creativecommons.org/licenses/by/4.0/)",
      "CC BY 4.0 (licenseurl: https://creativecommons.org/licenses/by/4.0/?ref=chooser-v1)",
    ],
    [
      "CC BY-SA 4.0 (licenseurl: https://creativecommons.org/licenses/by-sa/4.0/)",
      "CC BY-SA 4.0 (licenseurl: https://creativecommons.org/licenses/by-sa/4.0/?ref=chooser-v1)",
    ],
    [
      "CC0 1.0 (licenseurl: https://creativecommons.org/publicdomain/zero/1.0/)",
      "CC0 1.0 (licenseurl: https://creativecommons.org/publicdomain/zero/1.0/?ref=chooser-v1)",
    ],
  ];
  for (const [plain, withQuery] of pairs) {
    it(`${JSON.stringify(withQuery)} derives the same rights as its query-less twin`, () => {
      const expected = rightsForLicense(plain, REVIEWER);
      const actual = rightsForLicense(withQuery, REVIEWER);
      for (const modality of MODALITIES) {
        expect(actual[modality], `${withQuery} → ${modality}`).toBe(expected[modality]);
      }
      expect(trainingEligible(actual)).toBe(trainingEligible(expected));
    });
  }
});
