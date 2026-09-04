/**
 * Structural audit (pass 1) — engine/rights.ts license → rights derivation.
 *
 * `rightsForLicense` is the automated front door used by engine/acquire.ts and
 * engine/importLegacy.ts to derive per-modality rights from a free-text
 * license string. Its header states: "Anything not matched returns
 * all-unclear." These probes check that restrictive Creative Commons
 * variants (NonCommercial / NoDerivatives) and negated phrases are NOT
 * upgraded to permissive rights.
 *
 * Plane: Linux bench.
 */
import { describe, expect, it } from "vitest";
import {
  redistributionEligible,
  rightsForLicense,
  trainingEligible,
} from "../src/engine/rights.js";

const REVIEWER = "audit-probe";

describe("audit: restrictive CC variants are not upgraded to CC BY", () => {
  for (const license of ["CC BY-NC 4.0", "CC BY-NC-SA 4.0", "cc-by-nc-nd 3.0", "CC BY-NC-ND 4.0"]) {
    it(`${license}: commercial use is not affirmative`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(rights.commercial).not.toMatch(/^yes/);
      expect(rights.commercial).toBe("no");
      expect(trainingEligible(rights)).toBe(false);
      expect(rights.basis).toContain(license);
    });
  }

  for (const license of ["CC BY-ND 4.0", "CC BY-NC-ND 4.0"]) {
    it(`${license}: redistribution of derivatives is not affirmative`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(redistributionEligible(rights)).toBe(false);
      expect(rights.redistributeDerivatives).toBe("no");
      expect(rights.train).not.toMatch(/^yes|sharealike/);
      expect(trainingEligible(rights)).toBe(false);
    });
  }
});

describe("audit: negated / non-license phrases are not matched as public domain", () => {
  it("'NOT public domain — all rights reserved' is quarantined, not training-eligible", () => {
    const rights = rightsForLicense("NOT public domain — all rights reserved", REVIEWER);
    expect(trainingEligible(rights)).toBe(false);
    expect(redistributionEligible(rights)).toBe(false);
    for (const modality of [
      rights.store,
      rights.analyze,
      rights.annotate,
      rights.train,
      rights.redistributeDerivatives,
      rights.commercial,
    ]) {
      expect(modality).toBe("unclear");
    }
    for (const negated of [
      "not public domain",
      "Non-public domain footage",
      "no CC BY license granted",
      "Not CC0",
    ]) {
      const negatedRights = rightsForLicense(negated, REVIEWER);
      expect(negatedRights.train, negated).toBe("unclear");
      expect(trainingEligible(negatedRights), negated).toBe(false);
    }
  });
});

describe("audit: controls that hold", () => {
  it("unrecognized license is all-unclear and not training-eligible", () => {
    const rights = rightsForLicense("Standard YouTube License", REVIEWER);
    expect(rights.train).toBe("unclear");
    expect(trainingEligible(rights)).toBe(false);
    expect(redistributionEligible(rights)).toBe(false);
  });

  it("CC BY 3.0 is training-eligible with attribution", () => {
    const rights = rightsForLicense("CC BY 3.0", REVIEWER);
    expect(rights.train).toBe("yes_with_attribution");
    expect(rights.commercial).toBe("yes_with_attribution");
    expect(rights.redistributeDerivatives).toBe("yes_with_attribution");
    expect(trainingEligible(rights)).toBe(true);
    for (const permissive of [
      "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
      "CC0 1.0",
      "cc-by-4.0",
    ]) {
      expect(trainingEligible(rightsForLicense(permissive, REVIEWER)), permissive).toBe(true);
    }
  });

  it("CC BY-SA marks derivatives as sharealike", () => {
    const rights = rightsForLicense("CC BY-SA 4.0", REVIEWER);
    expect(rights.redistributeDerivatives).toBe("sharealike");
    expect(rights.commercial).toBe("yes_with_attribution");
    expect(rightsForLicense("cc-by-sa-3.0", REVIEWER).redistributeDerivatives).toBe("sharealike");
  });
});
