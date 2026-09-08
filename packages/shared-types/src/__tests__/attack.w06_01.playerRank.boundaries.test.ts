/**
 * W06-01 ADVERSARY — TS-plane boundary attacks on the canonical scoring
 * definition (candidate devin/pp/w06-01/impl-r2 @ 9c47cf07).
 *
 * Every test asserts the behaviour the canonical definition promises
 * ("identical inputs rank identically on mobile, Edge and SQL"; "input order
 * does not matter"; "every abstaining row is refused by ingress").  A failing
 * test is a confirmed break; a passing test is an attack that did not break
 * anything.  The tests never modify the candidate's code or fixtures.
 */
import { describe, expect, it } from "vitest";
import { computePlayerRank, type PlayerRankAnalysisInput } from "../playerRank.js";
import { SCORING_DEFINITION, SCORING_DEFINITION_VERSION } from "../scoringDefinition.js";

const COUNTABILITY = SCORING_DEFINITION.components.countability;

/** Mirrors supabase/functions/api/index.ts ISO_UTC_INSTANT_RE — the only
 * capturedAt grammar the production ingress admits. */
const EDGE_ISO_UTC_INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function scored(
  id: string,
  shotType: string,
  capturedAt: string,
  overallScore: number,
): PlayerRankAnalysisInput {
  return { id, shotType, capturedAt, overallScore, resultKind: "scored", source: "real" };
}

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("W06-01 attack: replay / duplicate identity", () => {
  it("a replayed id with conflicting content ranks the FIRST arrival, as SQL stores it", () => {
    // SQL keeps exactly one row per id (shots_pkey) and the Edge replay
    // detection keeps the FIRST arrival without reading the later copy; the
    // definition says duplicates are "count-once" and the survivor is the
    // first storable arrival.  The r3 adversary proved on PostgreSQL 16 that
    // a rule choosing any other survivor ranks a different multiset than the
    // account plane for the same arrival order, so each arrival order must
    // reproduce the server's outcome for THAT order — the two orders differ.
    const first = scored(ID_A, "drive", "2026-08-01T10:00:00.000Z", 9);
    const replay = scored(ID_A, "drive", "2026-08-01T11:00:00.000Z", 3);
    const forward = computePlayerRank([first, replay]);
    const reversed = computePlayerRank([replay, first]);
    expect(forward).toEqual(computePlayerRank([first]));
    expect(reversed).toEqual(computePlayerRank([replay]));
    expect(forward?.rating).toBe(9);
    expect(reversed?.rating).toBe(3);
    expect(COUNTABILITY.identity.survivor).toBe("first-storable-arrival");
  });

  it("uppercase and lowercase spellings of one uuid are one analysis in every position", () => {
    const lower = scored(ID_B, "dink", "2026-08-01T10:00:00.000Z", 7);
    const upper = { ...lower, id: ID_B.toUpperCase() };
    const other = scored(ID_C, "dink", "2026-08-01T09:00:00.000Z", 5);
    const summary = computePlayerRank([lower, other, upper]);
    expect(summary?.scoredAnalysisCount).toBe(2);
    expect(computePlayerRank([upper, other, lower])).toEqual(summary);
  });
});

describe("W06-01 attack: capturedAt grammar and precision", () => {
  it("counts only timestamps the production ingress grammar admits", () => {
    // Edge parseSyncShot refuses these before storage, so SQL can never rank
    // them.  Identical inputs → the TS plane must abstain too, or a device
    // shows a rank the server never accepts.
    const edgeRefused = [
      "2026-08-01", // date only
      "2026-08-01T10:00:00", // no zone
      "2026-08-01T12:00:00.000+02:00", // offset instead of Z
      "2026-08-01 10:00:00Z", // space separator
      "Jan 1 2026 (anything)", // V8 legacy free-form parse
      "2026-02-30T10:00:00.000Z", // calendar rollover (Edge round-trips the date)
    ];
    const leaks: string[] = [];
    for (const capturedAt of edgeRefused) {
      expect(
        EDGE_ISO_UTC_INSTANT_RE.test(capturedAt) && capturedAt !== "2026-02-30T10:00:00.000Z",
      ).toBe(false);
      const summary = computePlayerRank([scored(ID_A, "drive", capturedAt, 6)]);
      if (summary !== null) leaks.push(`${capturedAt} → rating ${summary.rating}`);
    }
    expect(leaks, `TS ranked rows the Edge ingress refuses:\n${leaks.join("\n")}`).toEqual([]);
  });

  it("abstains on a sub-microsecond instant that Postgres rounds up to the 2100 bound", () => {
    // The ingress admits 1..9 fractional digits; timestamptz keeps 6 and
    // ROUNDS.  2099-12-31T23:59:59.9999995Z is < 2100 for Date.parse (which
    // truncates to ms) but becomes 2100-01-01 in SQL and fails
    // shots_captured_at_bounds — so SQL never holds it while TS ranks it.
    const boundary = "2099-12-31T23:59:59.9999995Z";
    expect(EDGE_ISO_UTC_INSTANT_RE.test(boundary)).toBe(true);
    expect(Date.parse(boundary) < Date.parse(COUNTABILITY.capturedAt.maxExclusive)).toBe(true);
    expect(computePlayerRank([scored(ID_A, "drive", boundary, 6)])).toBeNull();
  });

  it("orders same-millisecond analyses by their microseconds like SQL, not by id", () => {
    // SQL: order by captured_at desc (microsecond precision), id desc.
    // Two rows 899µs apart inside one millisecond: the SQL-newest row is the
    // one with the SMALLER id.  Newest carries weight 8, the other weight 7.
    const newerByMicros = scored(ID_A, "drive", "2026-08-01T10:00:00.000900Z", 3);
    const olderByMicros = scored(ID_B, "drive", "2026-08-01T10:00:00.000001Z", 9);
    const summary = computePlayerRank([olderByMicros, newerByMicros]);
    const sqlTechniqueScore = Math.round((3 * 800 + 9 * 700) / 15) / 100; // 5.8
    expect(summary?.techniques[0]?.score).toBe(sqlTechniqueScore);
    expect(summary?.rating).toBe(sqlTechniqueScore);
  });

  it("treats the exact bounds the same way as the SQL check (inclusive floor, exclusive ceiling)", () => {
    expect(
      computePlayerRank([scored(ID_A, "drive", "2000-01-01T00:00:00.000Z", 6)]),
    ).not.toBeNull();
    expect(computePlayerRank([scored(ID_A, "drive", "1999-12-31T23:59:59.999Z", 6)])).toBeNull();
    expect(
      computePlayerRank([scored(ID_A, "drive", "2099-12-31T23:59:59.999Z", 6)]),
    ).not.toBeNull();
    expect(computePlayerRank([scored(ID_A, "drive", "2100-01-01T00:00:00.000Z", 6)])).toBeNull();
  });
});

describe("W06-01 attack: shotType text domain", () => {
  it("abstains on a shotType Postgres text can never store (embedded NUL)", () => {
    // Edge admits "drive\u0000" (trimmed non-empty, ≤64 chars); jsonb/text
    // refuse the NUL byte (22P05 / 22021), so apply_synced_shot can never
    // store the row and the client retries forever.  TS must not rank it.
    const nul = scored(ID_A, "drive\u0000", "2026-08-01T10:00:00.000Z", 6);
    expect(
      nul.shotType.trim().length > 0 && nul.shotType.length <= COUNTABILITY.shotType.maxLength,
    ).toBe(true);
    expect(computePlayerRank([nul])).toBeNull();
  });

  it("measures the 64-char cap in the same unit as the Edge parser (UTF-16 code units)", () => {
    // 33 emoji = 33 code points (SQL length() = 33 ≤ 64) but 66 code units:
    // Edge refuses it, so TS must abstain as well (no stored divergence).
    const emoji = "😀".repeat(33);
    expect(emoji.length).toBe(66);
    expect(computePlayerRank([scored(ID_A, emoji, "2026-08-01T10:00:00.000Z", 6)])).toBeNull();
    const bmp = "x".repeat(COUNTABILITY.shotType.maxLength);
    expect(computePlayerRank([scored(ID_A, bmp, "2026-08-01T10:00:00.000Z", 6)])).not.toBeNull();
    expect(computePlayerRank([scored(ID_A, `${bmp}x`, "2026-08-01T10:00:00.000Z", 6)])).toBeNull();
  });

  it("keeps whitespace-distinct shot types as distinct techniques (Edge stores them verbatim)", () => {
    const a = scored(ID_A, "drive", "2026-08-01T10:00:00.000Z", 6);
    const b = scored(ID_B, "drive ", "2026-08-01T10:00:00.000Z", 6);
    expect(computePlayerRank([a, b])?.techniqueCount).toBe(2);
  });

  it("orders equal-score techniques by code-unit order like GET /v1/rank and a C collation", () => {
    // Edge getPlayerRank sorts `a.shot_type < b.shot_type ? -1 : 1` (UTF-16
    // code units).  computePlayerRank must not use a locale collation that
    // puts "backhand" before "Dink".
    const summary = computePlayerRank([
      scored(ID_A, "backhand", "2026-08-01T10:00:00.000Z", 6),
      scored(ID_B, "Dink", "2026-08-01T10:00:00.000Z", 6),
      scored(ID_C, "_serve", "2026-08-01T10:00:00.000Z", 6),
    ]);
    const codeUnitOrder = ["Dink", "_serve", "backhand"];
    expect(summary?.techniques.map((t) => t.shotType)).toEqual(codeUnitOrder);
  });
});

describe("W06-01 attack: score boundary values", () => {
  const at = "2026-08-01T10:00:00.000Z";

  it("abstains on NaN, ±Infinity, negative and >10 scores and on -0 nothing breaks", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0.001,
      10.001,
    ]) {
      expect(computePlayerRank([scored(ID_A, "drive", at, bad)])).toBeNull();
    }
    const negZero = computePlayerRank([scored(ID_A, "drive", at, -0)]);
    expect(negZero?.rating).toBe(0);
    expect(Object.is(negZero?.rating, -0)).toBe(false);
  });

  it("quantizes exponent-notation and many-decimal scores exactly like numeric(4,2)", () => {
    // numeric(4,2) rounds the decimal TEXT half away from zero.
    const cases: Array<[number, number]> = [
      [1e-7, 0],
      [5e-7, 0],
      [0.005, 0.01],
      [0.0049999999, 0],
      [6.005, 6.01],
      [JSON.parse("6.00499999999999999") as number, 6.01], // wire text parses to 6.005
      [9.995, 10],
      [9.994999999, 9.99],
      [0.1 + 0.2, 0.3],
      [10, 10],
    ];
    for (const [input, want] of cases) {
      const summary = computePlayerRank([scored(ID_A, "drive", at, input)]);
      expect(summary?.techniques[0]?.score, String(input)).toBe(want);
    }
  });

  it("stamps the definition version on every ranked summary and never on no-rank", () => {
    expect(computePlayerRank([scored(ID_A, "drive", at, 5)])?.definitionVersion).toBe(
      SCORING_DEFINITION_VERSION,
    );
    expect(computePlayerRank([])).toBeNull();
    expect(
      computePlayerRank([
        {
          id: ID_A,
          shotType: "drive",
          capturedAt: at,
          overallScore: null,
          resultKind: "low_confidence",
        },
      ]),
    ).toBeNull();
  });
});
