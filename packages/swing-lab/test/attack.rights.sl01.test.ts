/**
 * Adversarial probe of the SL-01 fix (rightsForLicense anchoring + CC BY-NC/ND
 * derivation). Each case here FAILS on 06d55a0f and documents a concrete
 * failure mode of the changed code; the "regression" describe blocks return
 * all-unclear on 4d812e1a and permissive rights on the candidate.
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

describe("attack SL-01: bare `PD` prefix is upgraded to full public-domain rights (regression vs 4d812e1a)", () => {
  // 4d812e1a only recognised the literal `pd-usgov` tag; the candidate's
  // /^\s*pd(?:[ -]|$)/ promotes ANY string that merely starts with "PD" — including
  // qualified / disputed / unreviewed claims — to train=yes, trainingEligible=true.
  for (const license of [
    "PD - pending review",
    "PD (claimed by uploader, unverified)",
    "PD status disputed — uploader claim unverified",
    "PD until rightsholder responds",
  ]) {
    it(`${license}: a qualified PD claim must not be training-eligible`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(trainingEligible(rights), license).toBe(false);
      expect(rights.train, license).toBe("unclear");
    });
  }

  it("non-USGov PD tags do not get a U.S. federal government / CC0 legal basis", () => {
    for (const license of ["PD-self", "PD-old-70", "PD-US"]) {
      const rights = rightsForLicense(license, REVIEWER);
      if (trainingEligible(rights)) {
        expect(rights.basis, license).not.toContain("U.S. federal government works");
      }
    }
  });
});

describe("attack SL-01: CC BY-NC-SA redistribution is affirmative while the basis says it is quarantined", () => {
  it("CC BY-NC-SA 4.0: redistributeDerivatives is not affirmative for a NonCommercial license", () => {
    const rights = rightsForLicense("CC BY-NC-SA 4.0", REVIEWER);
    expect(rights.commercial).toBe("no");
    // basis promises "training and redistribution stay quarantined until a human review grants them"
    expect(rights.basis).toContain("redistribution stay quarantined");
    expect(redistributionEligible(rights)).toBe(false);
  });

  it("cc-by-sa-nc 3.0: element order does not change the answer", () => {
    const rights = rightsForLicense("cc-by-sa-nc 3.0", REVIEWER);
    expect(rights.commercial).toBe("no");
    expect(redistributionEligible(rights)).toBe(false);
  });
});

describe("attack SL-01: anchoring only guards LEADING negation (pre-existing on 4d812e1a, still open)", () => {
  for (const license of [
    "Public domain status disputed",
    "Public domain: NO — all rights reserved",
    "CC0 revoked — all rights reserved",
  ]) {
    it(`${license}: a qualified / negated public-domain phrase is not training-eligible`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(trainingEligible(rights), license).toBe(false);
    });
  }
});
