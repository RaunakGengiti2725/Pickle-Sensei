/**
 * Adversarial probes against the SL-01 fix (engine/rights.ts, bcf7ab91).
 *
 * The fix's header promises two invariants:
 *   (a) "a longer identifier can never be swallowed by a shorter prefix
 *       ('CC BY-NC' is not 'CC BY')", and
 *   (b) "text that merely mentions a license ('NOT public domain') does not
 *       name one".
 *
 * Every case below is a variant of the original SL-01 reproducer that still
 * yields permissive rights on the candidate. Each `it` FAILS on bcf7ab91; a
 * correct parser makes all of them pass. Behaviour on 4d812e1a is noted per
 * block so regressions are distinguishable from pre-existing gaps.
 *
 * Plane: Linux bench.
 */
import { describe, expect, it } from "vitest";
import {
  redistributionEligible,
  rightsForLicense,
  trainingEligible,
} from "../src/engine/rights.js";

const REVIEWER = "attack-probe";

describe("SL-01 attack: a restriction element after the leading designation must not be dropped", () => {
  // The parser stops at the first character outside `[a-z0-9.-]` and ignores
  // the rest of the string, so any separator other than exactly one space or
  // one ASCII hyphen between "BY" and "NC"/"ND" yields the full CC BY profile.
  // 4d812e1a: identical (pre-existing gap), EXCEPT the long-form spellings in
  // the second block, which 4d812e1a quarantined and the candidate now grants.
  for (const license of [
    "CC BY - NC 4.0",
    "CC BY \u2013NC 4.0",
    "CC BY/NC 4.0",
    "CC BY, NC 4.0",
    "CC BY 4.0; NC",
    "CC BY 4.0 NonCommercial",
    "CC BY 4.0-NC",
    "CC BY (NonCommercial) 4.0",
    "CC BY (NC-ND) 4.0",
    "CC BY\u200B-NC 4.0", // zero-width space before the hyphen
    "CC BY\u00AD-NC 4.0", // soft hyphen before the hyphen
    "CC BY\uFF0DNC 4.0", // fullwidth hyphen-minus
    "CC BY\u2043NC 4.0", // hyphen bullet
  ]) {
    it(`${JSON.stringify(license)}: NonCommercial denies commercial use`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(rights.commercial, `${license} → commercial`).not.toMatch(/^yes/);
      expect(trainingEligible(rights), `${license} → trainingEligible`).toBe(false);
    });
  }

  // Long-form element names are canonicalised ("Attribution" → "by",
  // "NonCommercial" → "nc"), but the canonical tokens are only honoured when
  // joined by exactly one `[ -]`. 4d812e1a returned all-unclear for these
  // three strings; the candidate grants full CC BY rights → regression.
  for (const license of [
    "Creative Commons Attribution, NonCommercial 4.0",
    "Creative Commons Attribution; NonCommercial-NoDerivs 4.0",
    "Creative Commons Attribution NoDerivativeWorks 3.0",
  ]) {
    it(`${JSON.stringify(license)}: restrictive long-form spelling is not upgraded to CC BY (regression vs 4d812e1a)`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(
        rights.commercial === "yes_with_attribution" &&
          rights.redistributeDerivatives === "yes_with_attribution",
        `${license} → granted the unrestricted CC BY profile`,
      ).toBe(false);
    });
  }

  it("'CC BY-SA 4.0, NoDerivs': trailing NoDerivs must not leave derivatives redistributable", () => {
    const rights = rightsForLicense("CC BY-SA 4.0, NoDerivs", REVIEWER);
    expect(redistributionEligible(rights)).toBe(false);
  });

  it("separator handling is at least self-consistent ('CC BY- NC' vs 'CC BY - NC')", () => {
    // Candidate: "CC BY- NC 4.0" → all-unclear, "CC BY - NC 4.0" → full CC BY.
    const tight = rightsForLicense("CC BY- NC 4.0", REVIEWER);
    const spaced = rightsForLicense("CC BY - NC 4.0", REVIEWER);
    expect(spaced.commercial).toBe(tight.commercial);
  });
});

describe("SL-01 attack: negated public-domain phrases outside the hedge allowlist", () => {
  // HEDGE_MARKERS is an allowlist of negation words; any negation not on it
  // leaves a leading "Public domain" fully permissive. 4d812e1a: identical
  // (pre-existing gap) — but the fix's own tests claim negated phrases are
  // quarantined. The first string is copied verbatim from
  // datasets/pickleball/registry.json.
  for (const license of [
    "Public Domain Mark 1.0 (item licenseurl field reads verbatim: https://creativecommons.org/publicdomain/mark/1.0/) — assessed FALSE",
    "Public domain — FALSE, this is copyrighted",
    "Public domain status revoked",
    "Public domain assessment rejected",
    "Public domain claim withdrawn",
    "Public domain (incorrect — the uploader was wrong)",
    "Public domain in the United States only; still copyrighted in its source country",
    "Public domain? (unsure)",
  ]) {
    it(`${JSON.stringify(license.slice(0, 60))}: is not training-eligible`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(trainingEligible(rights), `${license} → trainingEligible`).toBe(false);
      expect(redistributionEligible(rights), `${license} → redistributionEligible`).toBe(false);
    });
  }

  it("'CC BY 4.0 but the embedded music is copyrighted by a third party' is not redistributable", () => {
    const rights = rightsForLicense(
      "CC BY 4.0 but the embedded music is copyrighted by a third party",
      REVIEWER,
    );
    expect(redistributionEligible(rights)).toBe(false);
  });
});
