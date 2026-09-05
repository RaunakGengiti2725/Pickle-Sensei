/**
 * ADJ-01 acceptance pins — engine/rights.ts license → rights derivation.
 *
 * One `it` per acceptance criterion of finding pkg-swing-lab::ADJ-01
 * ("rightsForLicense() upgrades restrictive CC variants to CC BY and
 * substring-matches negated public-domain phrases"). The criteria are pinned
 * as written by the adjudicator; the corpus checks read the committed
 * registries so a stale stored rights record can never outlive a classifier
 * change.
 *
 * Plane: Linux bench.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSources, REPO_ROOT } from "../src/engine/corpus.js";
import {
  parseLicense,
  redistributionEligible,
  rightsForLicense,
  trainingEligible,
  type RightAnswer,
} from "../src/engine/rights.js";

const REVIEWER = "adj-01-acceptance";

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

describe("ADJ-01 criterion 1: NonCommercial never yields an affirmative commercial answer", () => {
  it("rightsForLicense('CC BY-NC 4.0').commercial is not 'yes' and not AFFIRMATIVE", () => {
    const { commercial } = rightsForLicense("CC BY-NC 4.0", REVIEWER);
    expect(commercial).not.toBe("yes");
    expect(AFFIRMATIVE.has(commercial)).toBe(false);
    expect(commercial).toBe("no");
  });
});

describe("ADJ-01 criterion 2: NC/ND variants never yield an affirmative redistributeDerivatives", () => {
  for (const license of ["CC BY-ND 4.0", "cc-by-nc-nd 3.0", "CC BY-NC-SA 4.0"]) {
    it(`${license}: redistributeDerivatives is 'no' or 'unclear'`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      expect(["no", "unclear"]).toContain(rights.redistributeDerivatives);
      expect(redistributionEligible(rights)).toBe(false);
    });
  }
});

describe("ADJ-01 criterion 3: negated public-domain phrases are quarantined", () => {
  it("'NOT public domain — all rights reserved' returns all 'unclear'", () => {
    const rights = rightsForLicense("NOT public domain — all rights reserved", REVIEWER);
    for (const modality of MODALITIES) {
      expect(rights[modality], modality).toBe("unclear");
    }
    expect(trainingEligible(rights)).toBe(false);
    expect(redistributionEligible(rights)).toBe(false);
  });
});

describe("ADJ-01 criterion 4: positive controls keep their affirmative profiles", () => {
  for (const license of ["CC0", "Public Domain"]) {
    it(`${license}: every modality is 'yes'`, () => {
      const rights = rightsForLicense(license, REVIEWER);
      for (const modality of MODALITIES) {
        expect(rights[modality], `${license} → ${modality}`).toBe("yes");
      }
      expect(trainingEligible(rights)).toBe(true);
      expect(redistributionEligible(rights)).toBe(true);
    });
  }

  it("CC BY 4.0: every modality is 'yes_with_attribution'", () => {
    const rights = rightsForLicense("CC BY 4.0", REVIEWER);
    for (const modality of MODALITIES) {
      expect(rights[modality], modality).toBe("yes_with_attribution");
    }
    expect(trainingEligible(rights)).toBe(true);
    expect(redistributionEligible(rights)).toBe(true);
  });

  it("CC BY-SA 4.0: training-eligible, commercial, derivatives sharealike", () => {
    const rights = rightsForLicense("CC BY-SA 4.0", REVIEWER);
    expect(rights.train).toBe("yes_with_attribution");
    expect(rights.commercial).toBe("yes_with_attribution");
    expect(rights.redistributeDerivatives).toBe("sharealike");
    expect(trainingEligible(rights)).toBe(true);
    expect(redistributionEligible(rights)).toBe(true);
  });

  it("only exact CC0 / PD / CC BY / CC BY-SA designations are affirmative for training", () => {
    for (const license of ["CC BY-NC 4.0", "CC BY-ND 4.0", "CC BY-NC-SA 4.0", "CC BY-NC-ND 4.0"]) {
      expect(trainingEligible(rightsForLicense(license, REVIEWER)), license).toBe(false);
    }
  });
});

interface RegistryLicenseEntry {
  id: string;
  license?: string;
}

interface PickleballRegistry {
  sources: RegistryLicenseEntry[];
  devPool: { items: RegistryLicenseEntry[] };
  evaluatedButExcluded: RegistryLicenseEntry[];
  quarantinedUnknownRights: RegistryLicenseEntry[];
}

function isRestrictiveCc(license: string): boolean {
  const parsed = parseLicense(license);
  if (parsed.kind === "creative_commons") {
    return parsed.elements.has("nc") || parsed.elements.has("nd");
  }
  return /\b(?:nc|nd|non[ -]?commercial|no[ -]?deriv)/i.test(license);
}

describe("ADJ-01 criterion 5: corpus registry entries with NC/ND licenses are not training-eligible", () => {
  const sources = loadSources();

  it("datasets/corpus/sources.json is non-empty", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it("every stored rights record matches the current classifier's derivation (no stale rights)", () => {
    for (const source of sources) {
      const derived = rightsForLicense(source.license, REVIEWER);
      for (const modality of MODALITIES) {
        expect(source.rights[modality], `${source.sourceId} → ${modality}`).toBe(derived[modality]);
      }
    }
  });

  it("no NC/ND-licensed corpus source is training- or redistribution-eligible", () => {
    for (const source of sources.filter((s) => isRestrictiveCc(s.license))) {
      expect(trainingEligible(source.rights), source.sourceId).toBe(false);
      expect(redistributionEligible(source.rights), source.sourceId).toBe(false);
    }
  });

  it("datasets/pickleball/registry.json keeps NC/ND items out of the sources and dev pools", () => {
    const registry = JSON.parse(
      readFileSync(join(REPO_ROOT, "datasets", "pickleball", "registry.json"), "utf8"),
    ) as PickleballRegistry;
    const eligiblePools = [...registry.sources, ...registry.devPool.items];
    for (const entry of eligiblePools) {
      if (entry.license === undefined) continue;
      expect(isRestrictiveCc(entry.license), `${entry.id}: ${entry.license}`).toBe(false);
    }
    const restrictive = [
      ...registry.evaluatedButExcluded,
      ...registry.quarantinedUnknownRights,
    ].filter((entry) => entry.license !== undefined && isRestrictiveCc(entry.license));
    for (const entry of restrictive) {
      const rights = rightsForLicense(entry.license ?? "", REVIEWER);
      expect(trainingEligible(rights), `${entry.id}: ${entry.license}`).toBe(false);
    }
  });
});
