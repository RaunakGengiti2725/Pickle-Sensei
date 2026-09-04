import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, type SourceRecord } from "../src/engine/corpus.js";
import {
  parseLicense,
  redistributionEligible,
  rightsForLicense,
  trainingEligible,
  type RightAnswer,
  type RightsProfile,
} from "../src/engine/rights.js";

/**
 * Rights classifier pins (ADJ-01).
 *
 * `rightsForLicense` is the ONLY classifier between a license string and a
 * training-eligible corpus source (acquire.ts registration, importLegacy.ts).
 * A restrictive Creative Commons element (NC / ND) or a negated phrase must
 * never produce an affirmative answer; only exact CC0 / public-domain /
 * CC BY / CC BY-SA tokens may.
 */

const AFFIRMATIVE: ReadonlySet<RightAnswer> = new Set([
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

const NON_COMMERCIAL = [
  "CC BY-NC 4.0",
  "cc-by-nc 4.0",
  "CC BY-NC-SA 4.0",
  "cc-by-nc-nd 3.0",
  "CC-BY-NC-ND",
];
const NO_DERIVATIVES = ["CC BY-ND 4.0", "cc-by-nd 3.0", "cc-by-nc-nd 3.0", "CC BY-NC-SA 4.0"];
const NEGATED = [
  "NOT public domain — all rights reserved",
  "not CC0 — copyright claimed by uploader",
  "Not CC BY: all rights reserved",
  "no public domain release; CC BY-SA was never granted",
];

const answers = (rights: RightsProfile) =>
  Object.fromEntries(MODALITIES.map((modality) => [modality, rights[modality]]));

describe("rightsForLicense — restrictive CC elements are never upgraded", () => {
  it.each(NON_COMMERCIAL)("%s: commercial use is not affirmative", (license) => {
    const rights = rightsForLicense(license, "test");
    expect(rights.commercial).not.toBe("yes");
    expect(AFFIRMATIVE.has(rights.commercial)).toBe(false);
    expect(["no", "unclear"]).toContain(rights.commercial);
  });

  it.each(NON_COMMERCIAL)("%s: training is not affirmative (commercial product)", (license) => {
    const rights = rightsForLicense(license, "test");
    expect(AFFIRMATIVE.has(rights.train)).toBe(false);
    expect(trainingEligible(rights)).toBe(false);
  });

  it.each(NO_DERIVATIVES)("%s: derivative redistribution is 'no' or 'unclear'", (license) => {
    const rights = rightsForLicense(license, "test");
    expect(["no", "unclear"]).toContain(rights.redistributeDerivatives);
    expect(redistributionEligible(rights)).toBe(false);
  });

  it("CC BY-ND never trains or redistributes derivatives affirmatively", () => {
    const rights = rightsForLicense("CC BY-ND 4.0", "test");
    expect(AFFIRMATIVE.has(rights.train)).toBe(false);
    expect(trainingEligible(rights)).toBe(false);
  });

  it("the basis names the restrictive element instead of claiming CC BY", () => {
    expect(rightsForLicense("CC BY-NC 4.0", "test").basis).not.toMatch(/CC BY permits any use/);
    expect(rightsForLicense("CC BY-ND 4.0", "test").basis).not.toMatch(/CC BY permits any use/);
  });
});

describe("rightsForLicense — negated / non-license phrases are quarantined", () => {
  it.each(NEGATED)("%s → every modality 'unclear'", (license) => {
    const rights = rightsForLicense(license, "test");
    for (const modality of MODALITIES) expect(rights[modality]).toBe("unclear");
    expect(trainingEligible(rights)).toBe(false);
    expect(redistributionEligible(rights)).toBe(false);
  });

  it.each([
    "Standard YouTube License",
    "",
    "CC",
    "CC BY-XY 4.0",
    "Creative Commons Attribution-NonCommercial 4.0 International",
    "CC BY 4.0 or CC BY-NC 4.0",
    "CC BY-SA 4.0 / CC BY-NC-ND 4.0",
    "all rights reserved",
  ])("%s → not training-eligible", (license) => {
    const rights = rightsForLicense(license, "test");
    expect(trainingEligible(rights)).toBe(false);
    expect(AFFIRMATIVE.has(rights.commercial)).toBe(false);
  });
});

describe("rightsForLicense — positive controls stay affirmative", () => {
  it.each(["CC0", "CC0 1.0", "Public Domain", "PD-USGov", "public domain (PD-US)"])(
    "%s → unrestricted",
    (license) => {
      const rights = rightsForLicense(license, "test");
      for (const modality of MODALITIES) expect(rights[modality]).toBe("yes");
      expect(trainingEligible(rights)).toBe(true);
      expect(redistributionEligible(rights)).toBe(true);
    },
  );

  it("DVIDS public-domain wording (as stored in the corpus) is unrestricted", () => {
    const rights = rightsForLicense(
      "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
      "test",
    );
    expect(answers(rights)).toEqual({
      store: "yes",
      analyze: "yes",
      annotate: "yes",
      train: "yes",
      redistributeDerivatives: "yes",
      commercial: "yes",
    });
  });

  it.each(["CC BY 4.0", "CC BY 3.0", "cc-by 2.0", "CC BY"])(
    "%s → attribution-only, training and commercial permitted",
    (license) => {
      const rights = rightsForLicense(license, "test");
      for (const modality of MODALITIES) expect(rights[modality]).toBe("yes_with_attribution");
      expect(trainingEligible(rights)).toBe(true);
      expect(redistributionEligible(rights)).toBe(true);
    },
  );

  it.each(["CC BY-SA 4.0", "cc-by-sa 3.0", "CC BY-SA"])(
    "%s → sharealike derivatives, otherwise attribution",
    (license) => {
      const rights = rightsForLicense(license, "test");
      expect(rights.redistributeDerivatives).toBe("sharealike");
      expect(rights.train).toBe("yes_with_attribution");
      expect(rights.commercial).toBe("yes_with_attribution");
      expect(trainingEligible(rights)).toBe(true);
      expect(redistributionEligible(rights)).toBe(true);
    },
  );
});

describe("parseLicense — canonical license parser (the only affirmative path)", () => {
  it.each([
    ["CC BY 4.0", "cc-by", "4.0"],
    ["cc-by-nc-nd 3.0", "cc-by-nc-nd", "3.0"],
    ["CC BY-SA-NC", "cc-by-nc-sa", null],
    ["CC-BY-NC-ND", "cc-by-nc-nd", null],
  ])("%s → canonical %s (version %s)", (license, id, version) => {
    const parsed = parseLicense(license);
    expect(parsed.status).toBe("recognized");
    if (parsed.status === "recognized" && parsed.license.kind === "cc") {
      expect(parsed.license.id).toBe(id);
      expect(parsed.license.version).toBe(version);
    } else {
      throw new Error(`expected a Creative Commons parse for ${license}`);
    }
  });

  it.each([
    ["NOT public domain — all rights reserved", "contradicted"],
    ["not CC0 — copyright claimed by uploader", "contradicted"],
    ["CC BY 4.0 (non-exclusive, restricted)", "contradicted"],
    ["CC BY-XY 4.0", "malformed"],
    ["CC", "malformed"],
    ["CC SA 1.0", "malformed"],
    ["CC BY 4.0 or CC BY-NC 4.0", "ambiguous"],
    ["Standard YouTube License", "unrecognized"],
    ["", "unrecognized"],
  ])("%s → %s (quarantined)", (license, status) => {
    expect(parseLicense(license).status).toBe(status);
    for (const modality of MODALITIES) {
      expect(rightsForLicense(license, "test")[modality]).toBe("unclear");
    }
  });

  it("restrictive answers are explicit refusals, not silent downgrades", () => {
    expect(answers(rightsForLicense("CC BY-NC 4.0", "test"))).toEqual({
      store: "unclear",
      analyze: "unclear",
      annotate: "unclear",
      train: "no",
      redistributeDerivatives: "no",
      commercial: "no",
    });
    expect(answers(rightsForLicense("CC BY-ND 4.0", "test"))).toEqual({
      store: "yes_with_attribution",
      analyze: "yes_with_attribution",
      annotate: "yes_with_attribution",
      train: "unclear",
      redistributeDerivatives: "no",
      commercial: "yes_with_attribution",
    });
    expect(rightsForLicense("CC BY-NC-SA 4.0", "test").redistributeDerivatives).toBe("no");
  });
});

describe("corpus registry — stored rights agree with the classifier", () => {
  const sources = JSON.parse(
    readFileSync(join(REPO_ROOT, "datasets/corpus/sources.json"), "utf8"),
  ) as SourceRecord[];

  it("has sources to re-evaluate", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("every stored rights record equals a fresh derivation from its license", () => {
    const drift = sources
      .map((source) => ({
        sourceId: source.sourceId,
        license: source.license,
        stored: answers(source.rights),
        derived: answers(rightsForLicense(source.license, "re-evaluation")),
      }))
      .filter((row) => JSON.stringify(row.stored) !== JSON.stringify(row.derived));
    expect(drift).toEqual([]);
  });

  it("no NC/ND-licensed source is training- or redistribution-eligible", () => {
    const restrictive = sources.filter((source) => /\b(nc|nd)\b/i.test(source.license));
    for (const source of restrictive) {
      expect(trainingEligible(rightsForLicense(source.license, "re-evaluation"))).toBe(false);
      expect(redistributionEligible(rightsForLicense(source.license, "re-evaluation"))).toBe(false);
    }
  });
});
