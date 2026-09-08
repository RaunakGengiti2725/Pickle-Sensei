/**
 * W06-01 ADVERSARY (round 3, candidate devin/pp/w06-01/impl-r3 @ e4fda763) —
 * TS-plane attacks on the canonical scoring definition and its golden fixture.
 *
 * A failing test is a confirmed break; a passing test is an attack that did
 * not break anything. Nothing here modifies the candidate's code, tests or
 * fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import golden from "../../fixtures/scoring/player-rank.golden.json" with { type: "json" };
import { computePlayerRank, type PlayerRankAnalysisInput } from "../playerRank.js";
import {
  SCORING_COUNTABILITY_RULE_KEYS,
  SCORING_DEFINITION,
  type PlayerRankGoldenFixture,
  type ScoringDefinition,
} from "../scoringDefinition.js";

const fixture: PlayerRankGoldenFixture = golden;
const AT = "2026-08-01T10:00:00.000Z";

function scored(
  shotType: string,
  capturedAt: string,
  overallScore: number,
  id?: string,
): PlayerRankAnalysisInput {
  return {
    ...(id === undefined ? {} : { id }),
    shotType,
    capturedAt,
    overallScore,
    resultKind: "scored",
    source: "real",
  };
}

// ─── Attack 1: recency order for rows without an id ─────────────────────────

describe("W06-01 r3 attack: input-order independence without ids", () => {
  it("ranks two id-less same-instant analyses identically in both input orders", () => {
    // computePlayerRank documents "Input order does not matter" and `id` is
    // optional "for input-shape compatibility (absent ids tie-break on the
    // raw string)". Two id-less rows with the SAME instant and the SAME raw
    // string have no tie-break left, so Array#sort keeps input order and the
    // newest-weight (8) lands on whichever row was handed in first.
    const nine = scored("drive", AT, 9);
    const three = scored("drive", AT, 3);
    const forward = computePlayerRank([nine, three]);
    const reversed = computePlayerRank([three, nine]);
    expect(forward).not.toBeNull();
    expect(reversed, `forward=${forward?.rating} reversed=${reversed?.rating}`).toEqual(forward);
  });

  it("ranks three id-less same-instant analyses identically from every permutation", () => {
    const rows = [scored("dink", AT, 2), scored("dink", AT, 6), scored("dink", AT, 9)];
    const ratings = new Set<number | undefined>();
    for (const order of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ]) {
      ratings.add(computePlayerRank(order.map((i) => rows[i]!))?.rating);
    }
    expect([...ratings], "one rating per multiset, whatever the input order").toHaveLength(1);
  });
});

// ─── Attack 2: does the golden fixture pin every declared abstention rule? ──

describe("W06-01 r3 attack: fixture coverage of the declared server-ingress checks", () => {
  it("names every declared server ingress check in at least one rejected input", () => {
    // The definition promises each countability rule is enforced by the
    // listed checks; a check no fixture row exercises is an unverified claim.
    const exercised = new Set(
      fixture.rejectedInputs.map((r) => `${r.refusedBy.layer}:${r.refusedBy.check}`),
    );
    for (const replay of fixture.replays) {
      if (replay.analyses.length > new Set(replay.analyses.map((a) => a.id.toLowerCase())).size) {
        exercised.add("sql:shots_pkey");
        exercised.add("edge:shots:sync replay acknowledgement");
      }
    }
    const unexercised: string[] = [];
    for (const rule of SCORING_COUNTABILITY_RULE_KEYS) {
      for (const check of SCORING_DEFINITION.components.countability.serverIngress[rule]) {
        const key = `${check.layer}:${check.check}`;
        if (!exercised.has(key)) unexercised.push(`${rule} → ${key}`);
      }
    }
    expect(
      unexercised,
      `declared ingress checks no fixture row exercises:\n${unexercised.join("\n")}`,
    ).toEqual([]);
  });

  it("pins every excluded shotType code point with a rejected input", () => {
    const excluded = SCORING_DEFINITION.components.countability.shotType.excludedCodePoints;
    expect(excluded.length).toBeGreaterThan(0);
    for (const codePoint of excluded) {
      const pinned = fixture.rejectedInputs.some((r) => r.analysis.shotType.includes(codePoint));
      expect(pinned, `U+${codePoint.codePointAt(0)!.toString(16).padStart(4, "0")} is pinned`).toBe(
        true,
      );
    }
  });

  it("pins the sub-microsecond half-even rounding at BOTH bounds with fixture rows", () => {
    // The definition says the fraction is rounded to microseconds BEFORE the
    // bounds check. That behaviour only exists in the fixture if a row sits
    // on each side of each bound after rounding.
    const rows = [
      ...fixture.cases.flatMap((c) => c.analyses),
      ...fixture.replays.flatMap((c) => c.analyses),
      ...fixture.rejectedInputs.map((r) => r.analysis),
    ];
    const texts = rows.map((r) => r.capturedAt);
    const roundsUpToMax = texts.some((t) => /^2099-12-31T23:59:59\.999999[5-9]\d*Z$/.test(t));
    const roundsUpToMin = texts.some((t) => /^1999-12-31T23:59:59\.999999[5-9]\d*Z$/.test(t));
    expect(roundsUpToMax, "a row that rounds up to 2100-01-01 (rejected)").toBe(true);
    expect(roundsUpToMin, "a row that rounds up to 2000-01-01 (countable)").toBe(true);
  });
});

// ─── Attack 3: mutation testing — does the fixture detect definition drift? ─

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

type MutableDefinition = Mutable<ScoringDefinition>;

interface Mutation {
  name: string;
  apply: (definition: MutableDefinition) => void;
}

function cloneDefinition(): MutableDefinition {
  return JSON.parse(JSON.stringify(SCORING_DEFINITION)) as MutableDefinition;
}

const TIER_KEYS = SCORING_DEFINITION.components.tiers.thresholds.map((t) => t.key);

const MUTATIONS: Mutation[] = [
  ...SCORING_DEFINITION.components.recencyWeights.weights.map<Mutation>((_w, index) => ({
    name: `recencyWeights[${index}] += 1`,
    apply: (d) => {
      d.components.recencyWeights.weights[index]! += 1;
    },
  })),
  {
    name: "formWindow.size 8 → 7 (weights trimmed)",
    apply: (d) => {
      d.components.formWindow.size = 7;
      d.components.recencyWeights.weights = [7, 6, 5, 4, 3, 2, 1];
    },
  },
  {
    name: "formWindow.size 8 → 9 (weights extended)",
    apply: (d) => {
      d.components.formWindow.size = 9;
      d.components.recencyWeights.weights = [9, 8, 7, 6, 5, 4, 3, 2, 1];
    },
  },
  {
    name: "confidenceWeight.cap 5 → 4",
    apply: (d) => void (d.components.confidenceWeight.cap = 4),
  },
  {
    name: "confidenceWeight.cap 5 → 6",
    apply: (d) => void (d.components.confidenceWeight.cap = 6),
  },
  {
    name: "confidenceWeight.cap 5 → uncapped (Number.MAX_SAFE_INTEGER)",
    apply: (d) => void (d.components.confidenceWeight.cap = Number.MAX_SAFE_INTEGER),
  },
  ...TIER_KEYS.slice(1).flatMap<Mutation>((key) => [
    {
      name: `tiers.${key}.minRating += 0.01`,
      apply: (d) => {
        const tier = d.components.tiers.thresholds.find((t) => t.key === key)!;
        tier.minRating = Math.round(tier.minRating * 100 + 1) / 100;
      },
    },
    {
      name: `tiers.${key}.minRating -= 0.01`,
      apply: (d) => {
        const tier = d.components.tiers.thresholds.find((t) => t.key === key)!;
        tier.minRating = Math.round(tier.minRating * 100 - 1) / 100;
      },
    },
  ]),
  {
    name: "tiers.topOfScale 10 → 11",
    apply: (d) => void (d.components.tiers.topOfScale = 11),
  },
  {
    name: "countability.overallScore.max 10 → 11",
    apply: (d) => void (d.components.countability.overallScore.max = 11),
  },
  {
    name: "countability.overallScore.min 0 → -1",
    apply: (d) => void (d.components.countability.overallScore.min = -1),
  },
  {
    name: "countability.shotType.maxLength 64 → 65",
    apply: (d) => void (d.components.countability.shotType.maxLength = 65),
  },
  {
    name: "countability.shotType.excludedCodePoints → []",
    apply: (d) => void (d.components.countability.shotType.excludedCodePoints = []),
  },
  {
    name: "countability.capturedAt.min → 1999-01-01",
    apply: (d) => void (d.components.countability.capturedAt.min = "1999-01-01T00:00:00.000Z"),
  },
  {
    name: "countability.capturedAt.maxExclusive → 2101-01-01",
    apply: (d) =>
      void (d.components.countability.capturedAt.maxExclusive = "2101-01-01T00:00:00.000Z"),
  },
  {
    name: "countability.resultKind scored → graded",
    apply: (d) => void (d.components.countability.resultKind = "graded"),
  },
  {
    name: "countability.source real → fixture",
    apply: (d) => void (d.components.countability.source = "fixture"),
  },
  {
    name: "countability.absentSourceCountsAs real → fixture",
    apply: (d) => void (d.components.countability.absentSourceCountsAs = "fixture"),
  },
];

/** Loads a fresh computePlayerRank bound to `definition` instead of the
 * canonical one, exactly as a drifted scoringDefinition.ts would be. */
async function rankWithDefinition(
  definition: MutableDefinition,
): Promise<typeof computePlayerRank> {
  vi.resetModules();
  vi.doMock("../scoringDefinition.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../scoringDefinition.js")>();
    return { ...actual, SCORING_DEFINITION: definition };
  });
  const module = await import("../playerRank.js");
  return module.computePlayerRank;
}

/** True when at least one fixture expectation no longer reproduces. */
function fixtureDetects(rank: typeof computePlayerRank): boolean {
  const same = (actual: unknown, expected: unknown) =>
    JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null);
  for (const goldenCase of fixture.cases) {
    if (!same(rank(goldenCase.analyses), goldenCase.expected)) return true;
  }
  for (const replay of fixture.replays) {
    if (!same(rank(replay.analyses), replay.expected)) return true;
  }
  for (const rejected of fixture.rejectedInputs) {
    if (rank([rejected.analysis]) !== null) return true;
  }
  return false;
}

describe("W06-01 r3 attack: the golden fixture detects every definition drift", () => {
  afterEach(() => {
    vi.doUnmock("../scoringDefinition.js");
    vi.resetModules();
  });

  it("control: the unmodified definition reproduces the whole fixture through the mock seam", async () => {
    const rank = await rankWithDefinition(cloneDefinition());
    expect(fixtureDetects(rank)).toBe(false);
  });

  it("every single-component mutation changes at least one golden expectation", async () => {
    const survivors: string[] = [];
    for (const mutation of MUTATIONS) {
      const definition = cloneDefinition();
      mutation.apply(definition);
      const rank = await rankWithDefinition(definition);
      if (!fixtureDetects(rank)) survivors.push(mutation.name);
    }
    expect(
      survivors,
      `definition mutations the golden fixture does NOT detect:\n${survivors.join("\n")}`,
    ).toEqual([]);
  });
});
