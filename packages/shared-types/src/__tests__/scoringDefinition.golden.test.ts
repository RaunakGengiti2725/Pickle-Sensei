import { describe, expect, it } from "vitest";
import golden from "../../fixtures/scoring/player-rank.golden.json" with { type: "json" };
import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  RANK_CONFIDENCE_CAP,
  RANK_FORM_WINDOW,
  type PlayerRankAnalysisInput,
} from "../playerRank.js";
import {
  PLAYER_RANK_GOLDEN_SCHEMA_VERSION,
  SCORING_COUNTABILITY_RULE_KEYS,
  SCORING_DEFINITION,
  SCORING_DEFINITION_COMPONENT_KEYS,
  SCORING_DEFINITION_VERSION,
  type PlayerRankGoldenAnalysis,
  type PlayerRankGoldenFixture,
  type ScoringCountabilityRuleKey,
} from "../scoringDefinition.js";

const fixture: PlayerRankGoldenFixture = golden;
const countability = SCORING_DEFINITION.components.countability;

/** The sync wire shapes the Edge ingress accepts (`parseSyncShot`). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?Z$/;

/** Grammar + calendar round-trip: the text names one instant on every plane
 * (`Date.parse` on the Edge, `timestamptz` input in SQL). */
function isInstantText(text: string): boolean {
  const match = ISO_UTC_INSTANT_RE.exec(text);
  if (!match) return false;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return false;
  const parsed = new Date(at);
  return (
    parsed.getUTCFullYear() === Number(match[1]) &&
    parsed.getUTCMonth() === Number(match[2]) - 1 &&
    parsed.getUTCDate() === Number(match[3])
  );
}

/** `parseSyncShot` capturedAt bounds: `Date.parse` milliseconds (digits
 * beyond the third are dropped). */
function edgeAdmitsInstant(text: string): boolean {
  if (!isInstantText(text)) return false;
  const at = Date.parse(text);
  return (
    at >= Date.parse(countability.capturedAt.min) &&
    at < Date.parse(countability.capturedAt.maxExclusive)
  );
}

/** C `rint()` (half to even), as Postgres rounds a parsed fraction to µs. */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const remainder = value - floor;
  if (remainder < 0.5) return floor;
  if (remainder > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The stored `timestamptz` in microseconds (fraction parsed as a double,
 * `* 1e6`, `rint`), independent of the implementation under test. */
function storedMicros(text: string): number {
  const match = ISO_UTC_INSTANT_RE.exec(text)!;
  const whole = Date.parse(text.replace(/\.\d+Z$/, "Z"));
  const fraction = match[4] === undefined ? 0 : roundHalfEven(Number(`0.${match[4]}`) * 1e6);
  return whole * 1000 + fraction;
}

/** `shots_captured_at_bounds`: [min, maxExclusive) on the stored µs. */
function sqlAdmitsInstant(text: string): boolean {
  if (!isInstantText(text)) return false;
  const at = storedMicros(text);
  return (
    at >= storedMicros(countability.capturedAt.min) &&
    at < storedMicros(countability.capturedAt.maxExclusive)
  );
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

function isCountabilityRule(value: string): value is ScoringCountabilityRuleKey {
  return (SCORING_COUNTABILITY_RULE_KEYS as readonly string[]).includes(value);
}

/** Every plane can store this row: it satisfies the Edge parser and every
 * `public.shots` CHECK, so SQL ranks the IDENTICAL input the TS plane sees. */
function violatedDomainRules(row: PlayerRankGoldenAnalysis): string[] {
  const violated: string[] = [];
  if (!UUID_RE.test(row.id)) violated.push("identity");
  if (
    row.shotType.trim().length === 0 ||
    row.shotType.length > countability.shotType.maxLength ||
    countability.shotType.excludedCodePoints.some((codePoint) => row.shotType.includes(codePoint))
  ) {
    violated.push("shotType");
  }
  if (row.resultKind === countability.resultKind) {
    if (
      typeof row.overallScore !== "number" ||
      !Number.isFinite(row.overallScore) ||
      row.overallScore < countability.overallScore.min ||
      row.overallScore > countability.overallScore.max
    ) {
      violated.push("overallScore");
    }
  } else if (row.resultKind !== "low_confidence" || row.overallScore !== null) {
    violated.push("resultKind");
  }
  if (row.source !== undefined && row.source !== countability.source) violated.push("source");
  if (!edgeAdmitsInstant(row.capturedAt) || !sqlAdmitsInstant(row.capturedAt)) {
    violated.push("capturedAt");
  }
  return violated;
}

/** `countability.identity.survivor` = first-storable-arrival, computed from
 * the domain oracle alone (not from `computePlayerRank`). */
function firstStorableArrivals(
  rows: readonly PlayerRankGoldenAnalysis[],
): PlayerRankGoldenAnalysis[] {
  const held = new Set<string>();
  const survivors: PlayerRankGoldenAnalysis[] = [];
  for (const row of rows) {
    if (violatedDomainRules(row).length > 0) continue;
    const id = row.id.toLowerCase();
    if (held.has(id)) continue;
    held.add(id);
    survivors.push(row);
  }
  return survivors;
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("canonical scoring definition", () => {
  it("carries the version id the golden fixture pins", () => {
    expect(SCORING_DEFINITION.version).toBe(SCORING_DEFINITION_VERSION);
    expect(SCORING_DEFINITION_VERSION).toBe("rank-form-weighted-v2");
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
    expect(components.scoreQuantization.perPoint).toBe(100);
    expect(components.confidenceWeight.cap).toBe(5);
    expect(components.tiers.thresholds.map((tier) => [tier.key, tier.minRating])).toEqual([
      ["bronze", 0],
      ["silver", 3.5],
      ["gold", 5],
      ["platinum", 6.5],
      ["diamond", 7.5],
    ]);
    expect(components.tiers.topOfScale).toBe(SCORING_DEFINITION.scale.max);
  });

  it("names the server ingress checks for every countability rule", () => {
    expect(Object.keys(countability.serverIngress).sort()).toEqual(
      [...SCORING_COUNTABILITY_RULE_KEYS].sort(),
    );
    for (const rule of SCORING_COUNTABILITY_RULE_KEYS) {
      const ingress = countability.serverIngress[rule];
      expect(ingress.length, rule).toBeGreaterThan(0);
      for (const { layer, check } of ingress) {
        expect(["edge", "sql"]).toContain(layer);
        expect(check.length).toBeGreaterThan(0);
      }
    }
    expect(countability.serverIngress.shotType.map((c) => c.layer)).toContain("edge");
    expect(countability.serverIngress.capturedAt.map((c) => c.layer)).toContain("edge");
    expect(countability.serverIngress.identity.map((c) => c.check)).toContain("shots_pkey");
  });

  it("pins the input domain shared with the ingress and the SQL column types", () => {
    expect(countability.shotType.lengthUnit).toBe("utf16-code-units");
    expect(countability.shotType.excludedCodePoints).toEqual(["\u0000"]);
    expect(countability.capturedAt.grammar).toBe("iso-8601-utc-instant");
    expect(countability.capturedAt.fractionDigits).toEqual({ min: 1, max: 9 });
    expect(countability.capturedAt.stored).toEqual({
      unit: "microseconds",
      fractionRounding: "half-even",
    });
    expect(countability.capturedAt.boundChecks).toEqual([
      {
        layer: "edge",
        check: "parseSyncShot capturedAt",
        unit: "milliseconds",
        fractionRounding: "truncate",
      },
      {
        layer: "sql",
        check: "shots_captured_at_bounds",
        unit: "microseconds",
        fractionRounding: "half-even",
      },
    ]);
    for (const check of countability.capturedAt.boundChecks) {
      expect(countability.serverIngress.capturedAt).toContainEqual({
        layer: check.layer,
        check: check.check,
      });
    }
    expect(ISO_UTC_INSTANT_RE.test(countability.capturedAt.min)).toBe(true);
    expect(ISO_UTC_INSTANT_RE.test(countability.capturedAt.maxExclusive)).toBe(true);
  });

  it("declares first-storable-arrival identity, like shots_pkey and the replay acknowledgement", () => {
    expect(countability.identity.field).toBe("id");
    expect(countability.identity.normalize).toBe("lowercase");
    expect(countability.identity.duplicates).toBe("count-once");
    expect(countability.identity.survivor).toBe("first-storable-arrival");
    expect(countability.identity.storableResultKinds).toEqual(["scored", "low_confidence"]);
    expect(countability.identity.storableResultKinds).toContain(countability.resultKind);
  });

  it("orders analyses and techniques by total, locale-free key lists", () => {
    const { components } = SCORING_DEFINITION;
    expect(components.recencyOrder.keys.map((k) => [k.field, k.direction])).toEqual([
      ["capturedAt", "desc"],
      ["id", "desc"],
      ["capturedAtText", "desc"],
      ["scoreHundredths", "desc"],
    ]);
    expect(components.rating.techniqueOrder.keys.map((k) => [k.field, k.direction])).toEqual([
      ["score", "desc"],
      ["shotType", "asc"],
    ]);
    const textKeys = [
      ...components.recencyOrder.keys,
      ...components.rating.techniqueOrder.keys,
    ].filter((k) => k.field === "id" || k.field === "capturedAtText" || k.field === "shotType");
    for (const key of textKeys) expect(key.collation, key.field).toBe("code-unit");
    expect(components.recencyOrder.keys.find((k) => k.field === "id")?.normalize).toBe("lowercase");
  });

  it("is deeply immutable and JSON-serialisable for the other planes", () => {
    expect(Object.isFrozen(SCORING_DEFINITION)).toBe(true);
    expect(Object.isFrozen(SCORING_DEFINITION.components.tiers.thresholds)).toBe(true);
    expect(Object.isFrozen(SCORING_DEFINITION.components.recencyWeights.weights)).toBe(true);
    expect(Object.isFrozen(SCORING_DEFINITION.components.countability.serverIngress)).toBe(true);
    expect(JSON.parse(JSON.stringify(SCORING_DEFINITION))).toEqual(SCORING_DEFINITION);
  });
});

describe("golden fixture: identical inputs on every plane", () => {
  it("has ranked cases, no-rank cases, replay cases and rejected inputs", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(14);
    expect(fixture.cases.some((c) => c.expected === null)).toBe(true);
    expect(fixture.cases.some((c) => c.expected !== null)).toBe(true);
    expect(fixture.replays.length).toBeGreaterThanOrEqual(4);
    expect(fixture.replays.some((r) => r.conflicting)).toBe(true);
    expect(fixture.replays.some((r) => !r.conflicting)).toBe(true);
    expect(fixture.replays.some((r) => r.expected === null)).toBe(true);
    expect(fixture.rejectedInputs.length).toBeGreaterThanOrEqual(8);
    const ids = [...fixture.cases, ...fixture.replays, ...fixture.rejectedInputs].map(
      (entry) => entry.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps every case row inside the input domain every plane can store", () => {
    for (const goldenCase of fixture.cases) {
      const ids = goldenCase.analyses.map((row) => row.id.toLowerCase());
      expect(new Set(ids).size, goldenCase.id).toBe(ids.length);
      for (const row of goldenCase.analyses) {
        expect(violatedDomainRules(row), `${goldenCase.id} / ${row.id}`).toEqual([]);
      }
    }
  });

  it("exercises the declared abstention rules with in-domain rows", () => {
    const rows = fixture.cases.flatMap((c) => c.analyses);
    expect(rows.some((row) => row.resultKind === "low_confidence")).toBe(true);
    expect(rows.some((row) => row.source === undefined)).toBe(true);
    expect(rows.some((row) => row.overallScore === countability.overallScore.min)).toBe(true);
    expect(rows.some((row) => row.overallScore === countability.overallScore.max)).toBe(true);
    expect(rows.some((row) => /[A-F]/.test(row.id))).toBe(true);
    expect(rows.some((row) => /\.\d{4,6}Z$/.test(row.capturedAt))).toBe(true);
    expect(rows.some((row) => /\.\d{7,9}Z$/.test(row.capturedAt))).toBe(true);
    expect(rows.some((row) => /[A-Z_]/.test(row.shotType))).toBe(true);
    expect(
      rows.some(
        (row) => typeof row.overallScore === "number" && String(row.overallScore).length > 4,
      ),
    ).toBe(true);
    const ranked = fixture.cases.filter((c) => c.expected !== null);
    expect(ranked.some((c) => c.analyses.length > RANK_FORM_WINDOW)).toBe(true);
    expect(ranked.some((c) => c.expected!.division === 1)).toBe(true);
    expect(ranked.some((c) => c.expected!.division === 2)).toBe(true);
    expect(ranked.some((c) => c.expected!.division === 3)).toBe(true);
    expect(ranked.some((c) => c.expected!.nextTier === null)).toBe(true);
    for (const tier of PLAYER_RANK_TIERS) {
      expect(
        ranked.some((c) => c.expected!.tier === tier.key),
        `a golden case reaches ${tier.key}`,
      ).toBe(true);
    }
  });

  it.each(fixture.cases.map((goldenCase) => [goldenCase.id, goldenCase] as const))(
    "%s reproduces the expected summary",
    (_id, goldenCase) => {
      expect(computePlayerRank(goldenCase.analyses)).toEqual(goldenCase.expected);
    },
  );

  it("stamps every ranked summary with the definition version", () => {
    for (const goldenCase of fixture.cases) {
      if (goldenCase.expected === null) continue;
      expect(goldenCase.expected.definitionVersion).toBe(SCORING_DEFINITION_VERSION);
      expect(computePlayerRank(goldenCase.analyses)?.definitionVersion).toBe(
        SCORING_DEFINITION_VERSION,
      );
    }
  });

  it("is independent of input order", () => {
    for (const goldenCase of fixture.cases) {
      for (const seed of [1, 7, 42]) {
        expect(computePlayerRank(shuffled(goldenCase.analyses, seed)), goldenCase.id).toEqual(
          goldenCase.expected,
        );
      }
    }
  });

  it("counts a replayed analysis once, like the SQL primary key", () => {
    for (const goldenCase of fixture.cases) {
      const replayed = [...goldenCase.analyses, ...goldenCase.analyses];
      expect(computePlayerRank(replayed), goldenCase.id).toEqual(goldenCase.expected);
      const upper = goldenCase.analyses.map((row) => ({ ...row, id: row.id.toUpperCase() }));
      expect(computePlayerRank([...goldenCase.analyses, ...upper]), goldenCase.id).toEqual(
        goldenCase.expected,
      );
    }
  });

  it("replay cases: duplicated ids, first storable arrival is the analysis", () => {
    for (const replay of fixture.replays) {
      const ids = replay.analyses.map((row) => row.id.toLowerCase());
      expect(new Set(ids).size, replay.id).toBeLessThan(ids.length);
      expect(replay.analyses.length, replay.id).toBeLessThanOrEqual(5);
      const survivors = firstStorableArrivals(replay.analyses);
      expect(survivors.length, replay.id).toBeGreaterThan(0);
      expect(computePlayerRank(replay.analyses), replay.id).toEqual(replay.expected);
      expect(computePlayerRank(survivors), replay.id).toEqual(replay.expected);
      const asDistinctRows = replay.analyses.map((row, index) => ({
        ...row,
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      }));
      expect(
        computePlayerRank(asDistinctRows),
        `${replay.id}: counting the replays would change the outcome`,
      ).not.toEqual(replay.expected);
    }
  });

  it("replay cases: every arrival order ranks its own first storable arrivals", () => {
    for (const replay of fixture.replays) {
      const outcomes = new Set<string>();
      for (const rows of permutations(replay.analyses)) {
        const summary = computePlayerRank(rows);
        expect(summary, replay.id).toEqual(computePlayerRank(firstStorableArrivals(rows)));
        outcomes.add(JSON.stringify(summary));
      }
      if (replay.conflicting) {
        expect(
          outcomes.size,
          `${replay.id}: a conflicting replay has order-dependent outcomes`,
        ).toBeGreaterThan(1);
      } else {
        expect(outcomes, `${replay.id}: identical copies rank alike from every order`).toEqual(
          new Set([JSON.stringify(replay.expected)]),
        );
      }
    }
  });

  it("rejected inputs are excluded by TS and refused by the server layers the entry names", () => {
    const anchor: PlayerRankAnalysisInput = {
      id: "0000000a-0000-4000-8000-000000000001",
      shotType: "third_shot_drop",
      overallScore: 4.4,
      resultKind: "scored",
      capturedAt: "2026-07-01T10:00:00.000Z",
      source: "real",
    };
    const anchorOnly = computePlayerRank([anchor]);
    expect(anchorOnly?.rating).toBe(4.4);
    const rulesCovered = new Set<string>();
    for (const rejected of fixture.rejectedInputs) {
      expect(isCountabilityRule(rejected.rule), rejected.id).toBe(true);
      if (!isCountabilityRule(rejected.rule)) continue;
      rulesCovered.add(rejected.rule);
      expect(violatedDomainRules(rejected.analysis), rejected.id).toContain(rejected.rule);
      expect(rejected.refusedBy.length, rejected.id).toBeGreaterThan(0);
      const layers = rejected.refusedBy.map((check) => check.layer);
      expect(new Set(layers).size, rejected.id).toBe(layers.length);
      expect(layers, `${rejected.id}: edge before sql`).toEqual(
        [...layers].sort((a, b) => (a === b ? 0 : a === "edge" ? -1 : 1)),
      );
      for (const check of rejected.refusedBy) {
        expect(countability.serverIngress[rejected.rule], rejected.id).toContainEqual(check);
      }
      if (rejected.rule === "capturedAt" && isInstantText(rejected.analysis.capturedAt)) {
        // A well-formed instant is refused by a plane exactly when that
        // plane's own bounds check, at its own precision, refuses it.
        expect(edgeAdmitsInstant(rejected.analysis.capturedAt), rejected.id).toBe(
          !layers.includes("edge"),
        );
        expect(sqlAdmitsInstant(rejected.analysis.capturedAt), rejected.id).toBe(
          !layers.includes("sql"),
        );
      }
      expect(computePlayerRank([rejected.analysis]), rejected.id).toBeNull();
      expect(computePlayerRank([anchor, rejected.analysis]), rejected.id).toEqual(anchorOnly);
    }
    const boundEntries = fixture.rejectedInputs.filter(
      (rejected) => rejected.rule === "capturedAt" && isInstantText(rejected.analysis.capturedAt),
    );
    expect(
      boundEntries.some((r) => r.refusedBy.every((c) => c.layer === "edge")),
      "an instant only the Edge millisecond check refuses",
    ).toBe(true);
    expect(
      boundEntries.some((r) => r.refusedBy.every((c) => c.layer === "sql")),
      "an instant only the SQL microsecond check refuses",
    ).toBe(true);
    expect([...rulesCovered].sort()).toEqual(
      ["capturedAt", "overallScore", "resultKind", "shotType", "source"].sort(),
    );
  });

  it("abstains on scores JSON cannot carry", () => {
    for (const overallScore of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        computePlayerRank([
          {
            id: "0000000b-0000-4000-8000-000000000001",
            shotType: "dink",
            overallScore,
            resultKind: "scored",
            capturedAt: "2026-07-01T10:00:00.000Z",
          },
        ]),
      ).toBeNull();
    }
  });
});
