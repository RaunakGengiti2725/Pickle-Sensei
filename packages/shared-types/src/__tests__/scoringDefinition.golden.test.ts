import { describe, expect, it } from "vitest";
import golden from "../../fixtures/scoring/player-rank.golden.json" with { type: "json" };
import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  RANK_CONFIDENCE_CAP,
  RANK_FORM_WINDOW,
} from "../playerRank.js";
import {
  PLAYER_RANK_GOLDEN_SCHEMA_VERSION,
  SCORING_DEFINITION,
  SCORING_DEFINITION_COMPONENT_KEYS,
  SCORING_DEFINITION_VERSION,
  type PlayerRankGoldenFixture,
} from "../scoringDefinition.js";

const fixture: PlayerRankGoldenFixture = golden;

describe("canonical scoring definition", () => {
  it("carries the version id the golden fixture pins", () => {
    expect(SCORING_DEFINITION.version).toBe(SCORING_DEFINITION_VERSION);
    expect(fixture.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
    expect(fixture.schemaVersion).toBe(PLAYER_RANK_GOLDEN_SCHEMA_VERSION);
  });

  it("defines exactly the nine components, in canonical order", () => {
    expect(SCORING_DEFINITION_COMPONENT_KEYS).toHaveLength(9);
    expect(Object.keys(SCORING_DEFINITION.components)).toEqual([
      ...SCORING_DEFINITION_COMPONENT_KEYS,
    ]);
  });

  it("is the single source of the rank constants playerRank exposes", () => {
    const { components } = SCORING_DEFINITION;
    expect(RANK_FORM_WINDOW).toBe(components.formWindow.size);
    expect(RANK_CONFIDENCE_CAP).toBe(components.confidenceWeight.cap);
    expect(PLAYER_RANK_TIERS).toBe(components.tiers.thresholds);
    expect(components.recencyWeights.weights).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(components.recencyWeights.weights).toHaveLength(components.formWindow.size);
    expect(components.countability.resultKind).toBe("scored");
    expect(components.countability.source).toBe("real");
    expect(components.techniqueScore.rounding).toEqual({
      mode: "half-away-from-zero",
      decimals: 2,
    });
    expect(components.rating.rounding).toEqual({ mode: "half-away-from-zero", decimals: 2 });
  });

  it("is deeply frozen and survives a JSON round trip for the other planes", () => {
    expect(Object.isFrozen(SCORING_DEFINITION)).toBe(true);
    expect(Object.isFrozen(SCORING_DEFINITION.components)).toBe(true);
    expect(Object.isFrozen(SCORING_DEFINITION.components.tiers.thresholds)).toBe(true);
    expect(Object.isFrozen(SCORING_DEFINITION.components.recencyWeights.weights)).toBe(true);
    expect(JSON.parse(JSON.stringify(SCORING_DEFINITION))).toEqual(SCORING_DEFINITION);
  });
});

describe("player-rank golden fixture", () => {
  it("has at least one abstention case and one ranked case", () => {
    expect(fixture.cases.some((c) => c.expected === null)).toBe(true);
    expect(fixture.cases.some((c) => c.expected !== null)).toBe(true);
    expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(fixture.cases.length);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))(
    "%s reproduces the golden summary",
    (_id, goldenCase) => {
      expect(computePlayerRank(goldenCase.analyses)).toEqual(goldenCase.expected);
    },
  );

  it.each(fixture.cases.map((c) => [c.id, c] as const))(
    "%s is independent of input order",
    (_id, goldenCase) => {
      const reversed = [...goldenCase.analyses].reverse();
      expect(computePlayerRank(reversed)).toEqual(goldenCase.expected);
    },
  );

  it("stamps every ranked summary with the definition version", () => {
    for (const goldenCase of fixture.cases) {
      const summary = computePlayerRank(goldenCase.analyses);
      if (goldenCase.expected === null) {
        expect(summary).toBeNull();
      } else {
        expect(summary?.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
        expect(goldenCase.expected.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
      }
    }
  });
});
