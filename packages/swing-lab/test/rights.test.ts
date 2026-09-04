import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, loadSources } from "../src/engine/corpus.js";
import {
  redistributionEligible,
  rightsForLicense,
  trainingEligible,
  type RightAnswer,
  type RightsProfile,
} from "../src/engine/rights.js";

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

function modalities(rights: RightsProfile): Record<(typeof MODALITIES)[number], RightAnswer> {
  return Object.fromEntries(MODALITIES.map((key) => [key, rights[key]])) as Record<
    (typeof MODALITIES)[number],
    RightAnswer
  >;
}

function expectQuarantined(license: string): void {
  const rights = rightsForLicense(license, "test");
  for (const key of MODALITIES) {
    expect(rights[key], `${JSON.stringify(license)} → ${key}`).toBe("unclear");
  }
  expect(trainingEligible(rights)).toBe(false);
  expect(redistributionEligible(rights)).toBe(false);
}

// Exact strings the adjudicator reproduced, plus the forms that appear in
// datasets/pickleball/registry.json (evaluatedButExcluded) so the classifier is
// pinned against the registry's own vocabulary.
const NON_COMMERCIAL = [
  "CC BY-NC 4.0",
  "cc-by-nc-nd 3.0",
  "CC BY-NC-SA 4.0",
  "CC BY-NC-SA 4.0 (item licenseurl field reads verbatim: https://creativecommons.org/licenses/by-nc-sa/4.0/)",
  "https://creativecommons.org/licenses/by-nc/4.0/",
  "Creative Commons Attribution-NonCommercial 4.0",
  "CC BY NC 4.0",
  "CC-BY-SA-NC 3.0",
  "CC BY 4.0 — not for commercial use",
];
const NO_DERIVATIVES = [
  "CC BY-ND 4.0",
  "cc-by-nc-nd 3.0",
  "https://creativecommons.org/licenses/by-nd/4.0/",
];

describe("rightsForLicense — restrictive CC variants are never upgraded to CC BY", () => {
  for (const license of NON_COMMERCIAL) {
    it(`${license}: commercial use is not affirmative`, () => {
      const rights = rightsForLicense(license, "test");
      expect(rights.commercial).not.toBe("yes");
      expect(AFFIRMATIVE.has(rights.commercial)).toBe(false);
      expect(rights.commercial).toBe("no");
      // Training a model for a commercial product is commercial use.
      expect(AFFIRMATIVE.has(rights.train)).toBe(false);
      expect(trainingEligible(rights)).toBe(false);
      expect(redistributionEligible(rights)).toBe(false);
    });
  }
  for (const license of NO_DERIVATIVES) {
    it(`${license}: derivatives may not be redistributed`, () => {
      const rights = rightsForLicense(license, "test");
      expect(["no", "unclear"]).toContain(rights.redistributeDerivatives);
      expect(redistributionEligible(rights)).toBe(false);
      expect(AFFIRMATIVE.has(rights.train)).toBe(false);
      expect(trainingEligible(rights)).toBe(false);
    });
  }
  it("CC BY-NC-SA is not mistaken for CC BY-SA", () => {
    const rights = rightsForLicense("CC BY-NC-SA 4.0", "test");
    expect(rights.redistributeDerivatives).not.toBe("sharealike");
    expect(AFFIRMATIVE.has(rights.redistributeDerivatives)).toBe(false);
  });
  it("the basis names the restriction instead of claiming CC BY permits any use", () => {
    expect(rightsForLicense("CC BY-NC 4.0", "test").basis).not.toMatch(/permits any use/i);
    expect(rightsForLicense("CC BY-ND 4.0", "test").basis).not.toMatch(/permits any use/i);
  });
});

describe("rightsForLicense — negated / hedged phrases are quarantined, not training-eligible", () => {
  const phrases = [
    "NOT public domain — all rights reserved",
    "not public domain",
    "This is not CC BY",
    "Public Domain Mark 1.0 (item licenseurl field reads verbatim: https://creativecommons.org/publicdomain/mark/1.0/) — assessed FALSE",
    "Mixed: VOA policy makes exclusively-VOA material public domain, but this video visibly contains AFP- and Reuters-watermarked footage, which VOA's policy states is licensed for VOA use only",
    "None declared; YouTube standard license; municipal works are not automatically public domain",
    "YouTube page license field unverified (yt-dlp blocked by YouTube bot check in this environment); plausible PD-USGov basis as VA-produced federal work, but not confirmed",
    "Unverified (same YouTube bot-check block); plausible PD-USGov for VA-shot footage, but highlight reels commonly contain licensed music",
    "All rights reserved",
  ];
  for (const phrase of phrases) {
    it(`${phrase.slice(0, 60)}…`, () => expectQuarantined(phrase));
  }
});

describe("rightsForLicense — positive controls keep their grants", () => {
  it.each([
    "CC0",
    "CC0 1.0",
    "Public Domain",
    "Public domain (U.S. federal government work, PD-USGov; DVIDS)",
    "PD-USGov",
  ])("%s grants every modality", (license) => {
    const rights = rightsForLicense(license, "test");
    expect(modalities(rights)).toEqual({
      store: "yes",
      analyze: "yes",
      annotate: "yes",
      train: "yes",
      redistributeDerivatives: "yes",
      commercial: "yes",
    });
    expect(trainingEligible(rights)).toBe(true);
  });
  it.each(["CC BY 4.0", "CC BY 3.0", "cc-by", "CC BY 3.0 (declared on YouTube watch page)"])(
    "%s grants everything with attribution",
    (license) => {
      const rights = rightsForLicense(license, "test");
      expect(modalities(rights)).toEqual({
        store: "yes_with_attribution",
        analyze: "yes_with_attribution",
        annotate: "yes_with_attribution",
        train: "yes_with_attribution",
        redistributeDerivatives: "yes_with_attribution",
        commercial: "yes_with_attribution",
      });
      expect(trainingEligible(rights)).toBe(true);
    },
  );
  it.each(["CC BY-SA 4.0", "Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)"])(
    "%s grants everything with attribution and sharealike derivatives",
    (license) => {
      const rights = rightsForLicense(license, "test");
      expect(modalities(rights)).toEqual({
        store: "yes_with_attribution",
        analyze: "yes_with_attribution",
        annotate: "yes_with_attribution",
        train: "yes_with_attribution",
        redistributeDerivatives: "sharealike",
        commercial: "yes_with_attribution",
      });
      expect(trainingEligible(rights)).toBe(true);
    },
  );
  it.each(["Standard YouTube License", "none declared", "MIT", "unknown", ""])(
    "%s (unrecognized) is quarantined",
    (license) => expectQuarantined(license),
  );
});

// The classifier is what acquire.ts and importLegacy.ts persist into the corpus
// registry, so re-derive every stored record and make sure nothing on disk is
// more permissive than the rule that produced it.
describe("corpus registry re-evaluation", () => {
  const RESTRICTIVE = /\bby[ -]n[cd]\b|non[ -]?commercial|no[ -]?deriv/i;

  it("every datasets/corpus/sources.json record matches the classifier", () => {
    const sources = loadSources();
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const derived = rightsForLicense(source.license, "re-evaluation");
      expect(modalities(source.rights), `${source.sourceId} (${source.license})`).toEqual(
        modalities(derived),
      );
      if (trainingEligible(source.rights)) {
        expect(RESTRICTIVE.test(source.license), `${source.sourceId} is NC/ND`).toBe(false);
        expect(trainingEligible(derived)).toBe(true);
      }
    }
  });

  it("no NC/ND license anywhere in the registries is training-eligible", () => {
    const licenses = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if ((key === "license" || key === "declaredLicense") && typeof value === "string") {
            licenses.add(value);
          }
          walk(value);
        }
      }
    };
    for (const file of [
      "datasets/corpus/sources.json",
      "datasets/paddle-bench/registry.json",
      "datasets/pickleball/registry.json",
    ]) {
      walk(JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")));
    }
    const restrictive = [...licenses].filter((license) => RESTRICTIVE.test(license));
    expect(
      restrictive.length,
      "fixture: the registries carry at least one NC/ND entry",
    ).toBeGreaterThan(0);
    for (const license of restrictive) {
      const rights = rightsForLicense(license, "re-evaluation");
      expect(trainingEligible(rights), license).toBe(false);
      expect(
        AFFIRMATIVE.has(rights.commercial) && AFFIRMATIVE.has(rights.redistributeDerivatives),
        license,
      ).toBe(false);
    }
  });
});
