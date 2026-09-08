/**
 * Identical inputs rank identically on every plane. These tests hold
 * `computePlayerRank` to the behaviour the SQL plane (`public.shots` +
 * `recompute_player_rank`) and the Edge ingress (`parseSyncShot`) already
 * exhibit, so a device never shows a rank the server would compute
 * differently — or never accept at all.
 */
import { describe, expect, it } from "vitest";
import { computePlayerRank, type PlayerRankAnalysisInput } from "../playerRank.js";

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AT = "2026-08-01T10:00:00.000Z";

function scored(
  id: string,
  shotType: string,
  capturedAt: string,
  overallScore: number,
): PlayerRankAnalysisInput {
  return { id, shotType, capturedAt, overallScore, resultKind: "scored", source: "real" };
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

describe("replayed ids: one analysis per id — the first storable arrival, like shots_pkey", () => {
  const first = scored(ID_A, "drive", "2026-08-01T10:00:00.000Z", 9);
  const replay = scored(ID_A, "drive", "2026-08-01T11:00:00.000Z", 3);
  const later = scored(ID_A, "serve", "2026-08-02T10:00:00.000Z", 6);

  it("keeps the row that arrives first and never reads a later copy's content", () => {
    expect(computePlayerRank([first, replay, later])).toEqual(computePlayerRank([first]));
    expect(computePlayerRank([replay, later, first])).toEqual(computePlayerRank([replay]));
    expect(computePlayerRank([later, replay, first])).toEqual(computePlayerRank([later]));
    expect(computePlayerRank([first, replay, later])?.scoredAnalysisCount).toBe(1);
  });

  it("ranks a conflicting replay exactly as the server that stored the same arrival order", () => {
    // SQL: the first insert under an id wins; a later insert is refused by
    // shots_pkey (or acknowledged as a replay) whatever its content. Every
    // arrival order therefore has ONE outcome shared by every plane, and two
    // orders may legitimately differ.
    for (const rows of permutations([first, replay, later])) {
      expect(computePlayerRank(rows)).toEqual(computePlayerRank([rows[0]!]));
    }
    expect(computePlayerRank([first, replay])?.rating).toBe(9);
    expect(computePlayerRank([replay, first])?.rating).toBe(3);
  });

  it("lets an abstaining row hold its id so a scored copy behind it never counts", () => {
    const abstained: PlayerRankAnalysisInput = {
      id: ID_A,
      shotType: "drive",
      capturedAt: AT,
      overallScore: null,
      resultKind: "low_confidence",
      source: "real",
    };
    const scoredCopy = scored(ID_A, "drive", AT, 9);
    expect(computePlayerRank([abstained, scoredCopy])).toBeNull();
    expect(computePlayerRank([scoredCopy, abstained])).toEqual(computePlayerRank([scoredCopy]));
    const other = scored(ID_B, "dink", AT, 5);
    expect(computePlayerRank([abstained, scoredCopy, other])).toEqual(computePlayerRank([other]));
  });

  it("lets a row no plane stores hold nothing", () => {
    const refused = [
      scored(ID_A, "drive", AT, 10.5),
      scored(ID_A, "", AT, 6),
      scored(ID_A, "drive", "2026-08-01T10:00:00", 6),
      { ...scored(ID_A, "drive", AT, 6), source: "fixture" },
      { ...scored(ID_A, "drive", AT, 6), resultKind: "partial", overallScore: null },
    ];
    const stored = scored(ID_A, "drive", AT, 7);
    for (const row of refused) {
      expect(computePlayerRank([row, stored]), JSON.stringify(row)).toEqual(
        computePlayerRank([stored]),
      );
    }
  });

  it("treats uppercase and lowercase spellings of one uuid as the same analysis", () => {
    const lower = scored(ID_B, "dink", "2026-08-01T10:00:00.000Z", 7);
    const upper = { ...lower, id: ID_B.toUpperCase() };
    const other = scored(ID_C, "dink", "2026-08-01T09:00:00.000Z", 5);
    const expected = computePlayerRank([lower, other]);
    expect(expected?.scoredAnalysisCount).toBe(2);
    for (const rows of permutations([lower, other, upper])) {
      expect(computePlayerRank(rows)).toEqual(expected);
    }
  });

  it("does not collapse distinct rows that carry no id", () => {
    const { id: _a, ...a } = scored(ID_A, "dink", AT, 4);
    const { id: _b, ...b } = scored(ID_A, "dink", "2026-08-02T10:00:00.000Z", 8);
    expect(computePlayerRank([a, b])?.scoredAnalysisCount).toBe(2);
    expect(computePlayerRank([b, a])).toEqual(computePlayerRank([a, b]));
  });
});

describe("capturedAt: the ingress grammar, timestamptz precision and the shots bounds", () => {
  it("counts only timestamps the sync ingress admits", () => {
    const refusedByIngress = [
      "2026-08-01",
      "2026-08-01T10:00:00",
      "2026-08-01T12:00:00.000+02:00",
      "2026-08-01 10:00:00Z",
      "2026-08-01T10:00:00.Z",
      "2026-08-01T10:00:00.0000000001Z",
      "Jan 1 2026 (anything)",
      "2026-02-30T10:00:00.000Z",
      "2026-13-01T10:00:00.000Z",
      "2026-08-01T24:00:00.000Z",
      "2026-08-01T10:60:00.000Z",
      "2026-08-01T10:00:60.000Z",
      "not-an-instant",
    ];
    const leaks: string[] = [];
    for (const capturedAt of refusedByIngress) {
      if (computePlayerRank([scored(ID_A, "drive", capturedAt, 6)]) !== null)
        leaks.push(capturedAt);
    }
    expect(leaks).toEqual([]);
    for (const capturedAt of [
      "2026-08-01T10:00:00Z",
      "2026-08-01T10:00:00.5Z",
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T10:00:00.000900Z",
      "2026-08-01T10:00:00.123456789Z",
      "2028-02-29T23:59:59.999Z",
    ]) {
      expect(computePlayerRank([scored(ID_A, "drive", capturedAt, 6)]), capturedAt).not.toBeNull();
    }
  });

  it("applies the shots bounds: inclusive 2000-01-01, exclusive 2100-01-01", () => {
    expect(
      computePlayerRank([scored(ID_A, "drive", "2000-01-01T00:00:00.000Z", 6)]),
    ).not.toBeNull();
    expect(computePlayerRank([scored(ID_A, "drive", "1999-12-31T23:59:59.999999Z", 6)])).toBeNull();
    expect(
      computePlayerRank([scored(ID_A, "drive", "2099-12-31T23:59:59.999999Z", 6)]),
    ).not.toBeNull();
    expect(computePlayerRank([scored(ID_A, "drive", "2100-01-01T00:00:00.000Z", 6)])).toBeNull();
  });

  it("counts a row only when EVERY plane's bounds check admits it", () => {
    // Upper end: inside 2099 at Date.parse milliseconds (Edge admits), but
    // timestamptz rounds half-even to 2100-01-01 (SQL refuses).
    expect(
      computePlayerRank([scored(ID_A, "drive", "2099-12-31T23:59:59.9999995Z", 6)]),
    ).toBeNull();
    expect(
      computePlayerRank([scored(ID_A, "drive", "2099-12-31T23:59:59.9999994Z", 6)]),
    ).not.toBeNull();
    // Lower end: timestamptz rounds up to 2000-01-01 (SQL stores), but the
    // Edge parser compares 1999-12-31T23:59:59.999 (refuses).
    expect(
      computePlayerRank([scored(ID_A, "drive", "1999-12-31T23:59:59.9999995Z", 6)]),
    ).toBeNull();
    expect(
      computePlayerRank([scored(ID_A, "drive", "1999-12-31T23:59:59.9999999Z", 6)]),
    ).toBeNull();
  });

  it("orders same-millisecond analyses by microseconds like SQL, not by id", () => {
    const newerByMicros = scored(ID_A, "drive", "2026-08-01T10:00:00.000900Z", 3);
    const olderByMicros = scored(ID_B, "drive", "2026-08-01T10:00:00.000001Z", 9);
    const summary = computePlayerRank([olderByMicros, newerByMicros]);
    expect(summary?.techniques[0]?.score).toBe(Math.round((3 * 800 + 9 * 700) / 15) / 100);
    expect(computePlayerRank([newerByMicros, olderByMicros])).toEqual(summary);
  });

  it("treats fractions that round to the same microsecond as one instant (id breaks the tie)", () => {
    const higherId = scored(ID_B, "drive", "2026-08-01T10:00:00.0000015Z", 9);
    const lowerId = scored(ID_A, "drive", "2026-08-01T10:00:00.0000024Z", 3);
    const summary = computePlayerRank([lowerId, higherId]);
    expect(summary?.techniques[0]?.score).toBe(Math.round((9 * 800 + 3 * 700) / 15) / 100);
    expect(summary?.techniques[0]?.capturedAt).toBe("2026-08-01T10:00:00.0000024Z");
    expect(computePlayerRank([higherId, lowerId])).toEqual(summary);
  });
});

describe("shotType: the text domain every plane can store", () => {
  it("abstains on a shot type Postgres text can never hold (embedded NUL)", () => {
    expect(computePlayerRank([scored(ID_A, "drive\u0000", AT, 6)])).toBeNull();
    expect(computePlayerRank([scored(ID_A, "\u0000", AT, 6)])).toBeNull();
  });

  it("measures the 64-character cap in UTF-16 code units like the ingress", () => {
    expect(computePlayerRank([scored(ID_A, "😀".repeat(33), AT, 6)])).toBeNull();
    expect(computePlayerRank([scored(ID_A, "x".repeat(64), AT, 6)])).not.toBeNull();
    expect(computePlayerRank([scored(ID_A, "x".repeat(65), AT, 6)])).toBeNull();
  });

  it("lists equal-score techniques in code-unit order like GET /v1/rank", () => {
    const summary = computePlayerRank([
      scored(ID_A, "backhand", AT, 6),
      scored(ID_B, "Dink", AT, 6),
      scored(ID_C, "_serve", AT, 6),
    ]);
    expect(summary?.techniques.map((t) => t.shotType)).toEqual(["Dink", "_serve", "backhand"]);
  });
});
