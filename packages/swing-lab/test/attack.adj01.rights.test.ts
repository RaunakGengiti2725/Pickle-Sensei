/**
 * Adversarial tests for the ADJ-01 fix (engine/rights.ts parseLicense /
 * rightsForLicense, candidate 837d6f43).
 *
 * The first block pins a deterministic gap in the candidate's new
 * HEDGE_MARKERS mechanism: the parser promises that a string which hedges,
 * negates or disputes the license it names is quarantined ("Any of them
 * anywhere in the string means a human must read it"), and it lists
 * "possibly | maybe | probably | likely | plausibly | unconfirmed | pending |
 * revoked | withdrawn | expired" — but the everyday synonyms below are not in
 * the list, so a hedged public-domain claim such as "Public domain (presumed)"
 * derives the all-'yes' profile and is training-eligible. acquire.ts's
 * COMMONS_ALLOWED_LICENSE (`^(public domain|pd|...)`) admits the same strings,
 * so the hedged claim reaches the stored rights record unreviewed. Behaviour
 * is identical on the integrated head f702f0f8 (no regression); the finding is
 * that the fix's hedge quarantine is a blocklist with obvious holes.
 *
 * The remaining blocks are invariants the candidate was attacked against and
 * survived (element ordering, unicode separators, boundary sizes, malformed
 * payloads, monotonic restriction) — kept as regression pins so a future
 * refactor cannot silently reopen them.
 *
 * Plane: Linux bench.
 */
import { describe, expect, it } from "vitest";
import {
  parseLicense,
  redistributionEligible,
  rightsForLicense,
  trainingEligible,
  type CcElement,
  type RightAnswer,
  type RightsProfile,
} from "../src/engine/rights.js";

const REVIEWER = "adj-01-attack";

/** Mirrors the module-private AFFIRMATIVE set in engine/rights.ts. */
const AFFIRMATIVE: ReadonlySet<RightAnswer> = new Set<RightAnswer>([
  "yes",
  "yes_with_attribution",
  "sharealike",
]);

const MODALITIES = [
  "store",
  "analyze",
  "annotate",
  "train",
  "redistributeDerivatives",
  "commercial",
] as const;

/** Restrictiveness order used by the candidate's `meet()`; mirrored for the monotonicity pin. */
const RESTRICTIVENESS: Readonly<Record<RightAnswer, number>> = {
  yes: 0,
  yes_with_attribution: 1,
  sharealike: 2,
  unclear: 3,
  no: 4,
};

function atLeastAsRestrictive(a: RightsProfile, b: RightsProfile): boolean {
  return MODALITIES.every((m) => RESTRICTIVENESS[a[m]] >= RESTRICTIVENESS[b[m]]);
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((head, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [head, ...rest]),
  );
}

// ── Break: hedged designations are still affirmative ──────────────────────

describe("ADJ-01 attack: a hedged or disputed designation must be quarantined, not affirmative", () => {
  const hedgedPublicDomain = [
    "Public domain (presumed)",
    "Public domain (assumed)",
    "Public domain (to be confirmed)",
    "Public domain (TBD)",
    "Public domain? unsure",
    "Public domain in the US; copyrighted elsewhere",
    "CC0 (terminated)",
  ];
  for (const license of hedgedPublicDomain) {
    it(`${JSON.stringify(license)} is not training-eligible`, () => {
      const parsed = parseLicense(license);
      const rights = rightsForLicense(license, REVIEWER);
      expect(parsed.kind, `parseLicense(${JSON.stringify(license)})`).toBe("unrecognized");
      expect(trainingEligible(rights), `train=${rights.train}`).toBe(false);
      expect(redistributionEligible(rights)).toBe(false);
    });
  }

  const hedgedCreativeCommons = [
    "CC BY 4.0 (assumed)",
    "CC BY 4.0 (presumed)",
    "CC BY 4.0 (unsure)",
    "CC BY 4.0 (uncertain)",
    "CC BY 4.0 (needs review)",
    "CC BY 4.0 – commercial use requires permission",
    "CC BY 4.0 – license terminated",
    "CC BY 4.0 – some rights reserved",
  ];
  for (const license of hedgedCreativeCommons) {
    it(`${JSON.stringify(license)} does not inherit the CC BY profile`, () => {
      const parsed = parseLicense(license);
      const rights = rightsForLicense(license, REVIEWER);
      expect(parsed.kind, `parseLicense(${JSON.stringify(license)})`).toBe("unrecognized");
      expect(AFFIRMATIVE.has(rights.commercial), `commercial=${rights.commercial}`).toBe(false);
      expect(trainingEligible(rights), `train=${rights.train}`).toBe(false);
    });
  }
});

// ── Survived: invariants the candidate holds ──────────────────────────────

describe("ADJ-01 attack (survived): Creative Commons element ordering never changes the profile", () => {
  const combos: ReadonlyArray<readonly CcElement[]> = [
    ["nc", "sa"],
    ["nc", "nd"],
    ["by", "nc", "sa"],
    ["by", "nc", "nd"],
  ];
  for (const combo of combos) {
    for (const sep of [" ", "-"]) {
      it(`every permutation of ${combo.join("+")} joined by ${JSON.stringify(sep)} agrees`, () => {
        const canonical = rightsForLicense(
          `CC BY-${combo.filter((e) => e !== "by").join("-")} 4.0`,
          REVIEWER,
        );
        for (const perm of permutations(combo.filter((e) => e !== "by"))) {
          const license = `CC${sep}BY${sep}${perm.join(sep)}${sep}4.0`;
          const rights = rightsForLicense(license, REVIEWER);
          for (const modality of MODALITIES) {
            expect(rights[modality], `${license} → ${modality}`).toBe(canonical[modality]);
          }
        }
      });
    }
  }
});

describe("ADJ-01 attack (survived): adding an element only ever restricts", () => {
  const base = rightsForLicense("CC BY 4.0", REVIEWER);
  for (const suffix of ["SA", "NC", "ND", "NC-SA", "NC-ND"]) {
    it(`CC BY-${suffix} 4.0 is at least as restrictive as CC BY 4.0 in every modality`, () => {
      const rights = rightsForLicense(`CC BY-${suffix} 4.0`, REVIEWER);
      expect(atLeastAsRestrictive(rights, base)).toBe(true);
      if (suffix.includes("NC") || suffix.includes("ND")) {
        expect(trainingEligible(rights)).toBe(false);
        expect(redistributionEligible(rights)).toBe(false);
      }
    });
  }
});

describe("ADJ-01 attack (survived): unicode, whitespace and boundary-size variants", () => {
  const ncVariants = [
    "CC BY\u2011NC 4.0",
    "CC BY\u2013NC 4.0",
    "CC BY\u2014NC 4.0",
    "CC BY\u2212NC 4.0",
    "CC\u00a0BY-NC\u00a04.0",
    "CC\tBY\tNC\t4.0",
    "CC\nBY-NC\n4.0",
    "  cc by-nc 4.0  ",
    "CC BY-NC 4.0\u0000",
    `CC BY-NC 4.0 ${"x".repeat(100_000)}`,
  ];
  for (const license of ncVariants) {
    it(`${JSON.stringify(license.slice(0, 40))} keeps NonCommercial`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(rights.commercial).toBe("no");
      expect(trainingEligible(rights)).toBe(false);
      expect(redistributionEligible(rights)).toBe(false);
    });
  }

  const obfuscated = [
    "CC BY-N\u200bC 4.0",
    "CC BY-N\u0441 4.0",
    "\u0421C BY-NC 4.0",
    "\u200bCC BY-NC 4.0",
    "CC BY\u00adNC 4.0",
    "\uff23\uff23 \uff22\uff39 4.0",
    "CC BY-NCSA 4.0",
    "CC BY-NC-SA-ND 4.0",
    "CC BY 4.0 NC",
    "CC BY 4.0 — non-commercial use",
    "CC BY 4.0 OR CC BY-NC 4.0",
    `CC BY ${"-nc".repeat(50_000)} 4.0`,
  ];
  for (const license of obfuscated) {
    it(`${JSON.stringify(license.slice(0, 40))} is quarantined, never affirmative`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(parseLicense(license).kind).toBe("unrecognized");
      for (const modality of MODALITIES) {
        expect(rights[modality], modality).toBe("unclear");
      }
    });
  }

  it("malformed payloads never throw and never grant", () => {
    for (const license of [
      "",
      " ",
      "\u0000",
      "\ufeff",
      "-",
      "cc",
      "by",
      "nc",
      "4.0",
      "pd-",
      "cc0-nc",
    ]) {
      const rights = rightsForLicense(license, REVIEWER);
      expect(trainingEligible(rights), JSON.stringify(license)).toBe(false);
      expect(redistributionEligible(rights), JSON.stringify(license)).toBe(false);
    }
  });
});
