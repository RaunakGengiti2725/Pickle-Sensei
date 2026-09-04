/**
 * Structural audit (pass 1) — engine/rights.ts license → rights derivation.
 *
 * `rightsForLicense` is the automated front door used by engine/acquire.ts and
 * engine/importLegacy.ts to derive per-modality rights from a free-text
 * license string. Its header states: "Anything not matched returns
 * all-unclear." These probes check that restrictive Creative Commons
 * variants (NonCommercial / NoDerivatives) and negated phrases are NOT
 * upgraded to permissive rights. The first three blocks are the adjudicator's
 * reproducer (finding SL-01, verbatim); the SL-01 blocks below pin the exact
 * expected values and the parser that now backs the derivation.
 *
 * Plane: Linux bench.
 */
import { describe, expect, it } from "vitest";
import {
  parseLicense,
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
    });
  }

  for (const license of ["CC BY-ND 4.0", "CC BY-NC-ND 4.0"]) {
    it(`${license}: redistribution of derivatives is not affirmative`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(redistributionEligible(rights)).toBe(false);
    });
  }
});

describe("audit: negated / non-license phrases are not matched as public domain", () => {
  it("'NOT public domain — all rights reserved' is quarantined, not training-eligible", () => {
    const rights = rightsForLicense("NOT public domain — all rights reserved", REVIEWER);
    expect(trainingEligible(rights)).toBe(false);
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
    expect(trainingEligible(rights)).toBe(true);
  });

  it("CC BY-SA marks derivatives as sharealike", () => {
    const rights = rightsForLicense("CC BY-SA 4.0", REVIEWER);
    expect(rights.redistributeDerivatives).toBe("sharealike");
  });
});

// ── SL-01 regression: exact expected values (not just "not affirmative") ──

const MODALITIES = [
  "store",
  "analyze",
  "annotate",
  "train",
  "redistributeDerivatives",
  "commercial",
] as const;

function allUnclear(license: string): void {
  const rights = rightsForLicense(license, REVIEWER);
  for (const modality of MODALITIES) {
    expect(rights[modality], `${license} → ${modality}`).toBe("unclear");
  }
  expect(trainingEligible(rights)).toBe(false);
  expect(redistributionEligible(rights)).toBe(false);
}

describe("SL-01: NonCommercial denies commercial use and quarantines training", () => {
  for (const license of [
    "CC BY-NC 4.0",
    "CC BY-NC-SA 4.0",
    "cc-by-nc 2.5",
    "Creative Commons Attribution-NonCommercial 4.0 International",
  ]) {
    it(`${license}`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(rights.commercial).toBe("no");
      expect(rights.train).toBe("unclear");
      expect(trainingEligible(rights)).toBe(false);
      // Private storage/analysis for non-commercial purposes stays permitted.
      expect(rights.store).toBe("yes_with_attribution");
      expect(rights.analyze).toBe("yes_with_attribution");
    });
  }

  it("CC BY-NC-SA keeps the ShareAlike derivative term", () => {
    expect(rightsForLicense("CC BY-NC-SA 4.0", REVIEWER).redistributeDerivatives).toBe(
      "sharealike",
    );
  });
});

describe("SL-01: NoDerivatives denies redistribution of derivatives and quarantines training", () => {
  for (const license of [
    "CC BY-ND 4.0",
    "cc-by-nd 3.0",
    "Creative Commons Attribution-NoDerivatives 4.0 International",
  ]) {
    it(`${license}`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(rights.redistributeDerivatives).toBe("no");
      expect(redistributionEligible(rights)).toBe(false);
      expect(rights.train).toBe("unclear");
      expect(trainingEligible(rights)).toBe(false);
      expect(rights.commercial).toBe("yes_with_attribution");
    });
  }

  it("CC BY-NC-ND combines both restrictions", () => {
    const rights = rightsForLicense("CC BY-NC-ND 4.0", REVIEWER);
    expect(rights.commercial).toBe("no");
    expect(rights.redistributeDerivatives).toBe("no");
    expect(rights.train).toBe("unclear");
    expect(trainingEligible(rights)).toBe(false);
    expect(redistributionEligible(rights)).toBe(false);
  });
});

describe("SL-01: negated, hedged, or unknown-element strings are all-unclear", () => {
  for (const license of [
    "NOT public domain — all rights reserved",
    "not CC BY 4.0",
    "Public domain status disputed",
    "Possibly public domain (unverified)",
    "CC BY-XYZ 4.0",
    "CC BY-SA-ND 4.0",
    "All rights reserved © 2026",
    "",
  ]) {
    it(`${JSON.stringify(license)}`, () => allUnclear(license));
  }
});

describe("SL-01: permissive controls keep their full profiles (corpus strings)", () => {
  for (const license of [
    "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
    "Public domain (U.S. federal government work, PD-USGov)",
    "PD-USGov",
    "CC0 1.0",
  ]) {
    it(`${license} grants every modality`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      for (const modality of MODALITIES) {
        expect(rights[modality], `${license} → ${modality}`).toBe("yes");
      }
      expect(trainingEligible(rights)).toBe(true);
      expect(redistributionEligible(rights)).toBe(true);
    });
  }

  for (const license of [
    "CC BY 3.0",
    "cc-by-4.0",
    "Creative Commons Attribution 4.0 International",
  ]) {
    it(`${license} grants every modality with attribution`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      for (const modality of MODALITIES) {
        expect(rights[modality], `${license} → ${modality}`).toBe("yes_with_attribution");
      }
      expect(trainingEligible(rights)).toBe(true);
      expect(redistributionEligible(rights)).toBe(true);
    });
  }

  it("CC BY-SA is training-eligible and commercial, with ShareAlike derivatives", () => {
    const rights = rightsForLicense("CC BY-SA 4.0", REVIEWER);
    expect(rights.redistributeDerivatives).toBe("sharealike");
    expect(rights.commercial).toBe("yes_with_attribution");
    expect(trainingEligible(rights)).toBe(true);
    expect(redistributionEligible(rights)).toBe(true);
  });

  it("basis cites the license string and the reviewer is recorded", () => {
    const rights = rightsForLicense("CC BY-NC 4.0", REVIEWER);
    expect(rights.basis).toContain("CC BY-NC 4.0");
    expect(rights.reviewedBy).toBe(REVIEWER);
    expect(Number.isNaN(Date.parse(rights.reviewedAtIso))).toBe(false);
  });
});

describe("SL-01 mechanism: parseLicense yields a structured designation", () => {
  it("parses Creative Commons element sets and versions, in any spelling", () => {
    for (const [license, elements, version] of [
      ["CC BY 3.0", ["by"], "3.0"],
      ["cc-by-4.0", ["by"], "4.0"],
      ["CC BY-NC-SA 4.0", ["by", "nc", "sa"], "4.0"],
      ["cc-by-nc-nd 3.0", ["by", "nc", "nd"], "3.0"],
      ["CC BY-ND", ["by", "nd"], null],
      ["Creative Commons Attribution-ShareAlike 2.5 Generic", ["by", "sa"], "2.5"],
      ["Creative Commons Attribution-NonCommercial-NoDerivs 3.0", ["by", "nc", "nd"], "3.0"],
    ] as const) {
      const parsed = parseLicense(license);
      expect(parsed.kind, license).toBe("creative_commons");
      if (parsed.kind !== "creative_commons") continue;
      expect([...parsed.elements].sort(), license).toEqual([...elements].sort());
      expect(parsed.version, license).toBe(version);
    }
  });

  it("parses public-domain designations that lead the string", () => {
    for (const license of [
      "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
      "PD-USGov",
      "PD-self",
      "CC0 1.0 Universal",
      "CC0",
    ]) {
      expect(parseLicense(license).kind, license).toBe("public_domain");
    }
  });

  it("refuses designations that do not lead the string or carry a hedge", () => {
    for (const [license, reasonFragment] of [
      ["NOT public domain — all rights reserved", "hedge marker"],
      ["Released into the public domain by the author", "no known license designation"],
      ["Standard YouTube License", "no known license designation"],
      ["CC BY-SA-ND 4.0", "never appear together"],
      ["CC BY-XYZ 4.0", "no known license designation"],
      ["", "empty"],
    ] as const) {
      const parsed = parseLicense(license);
      expect(parsed.kind, license).toBe("unrecognized");
      if (parsed.kind === "unrecognized") expect(parsed.reason, license).toContain(reasonFragment);
    }
  });

  it("unrecognized basis explains why so the human reviewer sees the trigger", () => {
    expect(rightsForLicense("NOT public domain — all rights reserved", REVIEWER).basis).toContain(
      'hedge marker ("not")',
    );
  });
});
