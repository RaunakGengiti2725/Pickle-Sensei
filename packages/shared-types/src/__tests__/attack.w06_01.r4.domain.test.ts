/**
 * W06-01 ADVERSARY (round 4, candidate devin/pp/w06-01/impl-r4 @ 61206685)
 *
 * Domain attacks on the countability promise "a row counts on the TS plane
 * only when every server plane would store it, and identical inputs rank
 * identically on mobile, Edge and SQL":
 *   - identity domain (ids the Edge `isUuid` gate refuses — malformed, nil,
 *     bad variant, bare/braced Postgres spellings, padded),
 *   - shotType text the Postgres jsonb/text input refuses (lone surrogates),
 *   - capture instants at the grammar edges (leap second, 24:00, year 0000,
 *     lowercase `z`, `+00:00`, trailing whitespace),
 *   - the production iOS capture shape (`ISO8601DateFormatter` default: no
 *     fraction) and its presence in the golden fixture,
 *   - frozen-definition mutation attempts from a consumer,
 *   - exported constant identity (the definition is the single source).
 *
 * A failing test is a confirmed break; a passing one an attack that held.
 */
import { describe, expect, it } from "vitest";
import golden from "../../fixtures/scoring/player-rank.golden.json" with { type: "json" };
import {
  computePlayerRank,
  PLAYER_RANK_TIERS,
  RANK_CONFIDENCE_CAP,
  RANK_FORM_WINDOW,
  type PlayerRankAnalysisInput,
} from "../playerRank.js";
import { SCORING_DEFINITION, type PlayerRankGoldenFixture } from "../scoringDefinition.js";

const fixture: PlayerRankGoldenFixture = golden;
const AT = "2026-08-01T10:00:00.000Z";

/** supabase/functions/api/index.ts UUID_RE — the only id the sync ingress admits. */
const EDGE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** supabase/functions/api/index.ts ISO_UTC_INSTANT_RE. */
const EDGE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

function scored(id: string | undefined, shotType: string, capturedAt: string, score: number) {
  const row: PlayerRankAnalysisInput = {
    shotType,
    capturedAt,
    overallScore: score,
    resultKind: "scored",
    source: "real",
  };
  if (id !== undefined) row.id = id;
  return row;
}

const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("W06-01 r4 attack: identity domain", () => {
  it("abstains on ids the sync ingress refuses (no plane can ever store them)", () => {
    // parseSyncShot: `if (!isUuid(value.id)) return invalid("id must be a uuid.")`.
    // Every row below is refused by the Edge before storage, so SQL never
    // ranks it; the TS plane must not rank it either or a device shows
    // evidence the account never accepts.  The candidate's own golden oracle
    // (`violatedDomainRules`) already names this rule "identity", yet the
    // fixture's rejectedInputs never exercise it.
    const refusedIds = [
      "not-a-uuid",
      "dink-2026-08-01T10:00:00.000Z", // the shape apps/mobile/__tests__/playerRank.test.ts feeds
      "00000000-0000-0000-0000-000000000000", // nil uuid: version nibble 0 fails [1-8]
      "aaaaaaaa-aaaa-4aaa-caaa-aaaaaaaaaaaa", // variant nibble c fails [89ab]
      "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa", // no hyphens (Postgres uuid accepts, Edge refuses)
      "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}", // braces (Postgres uuid accepts, Edge refuses)
      " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", // leading space
    ];
    const leaks: string[] = [];
    for (const id of refusedIds) {
      expect(EDGE_UUID_RE.test(id), id).toBe(false);
      const summary = computePlayerRank([scored(id, "dink", AT, 6)]);
      if (summary !== null) leaks.push(`${JSON.stringify(id)} → rating ${summary.rating}`);
    }
    expect(leaks, `TS ranked rows whose id the Edge refuses:\n${leaks.join("\n")}`).toEqual([]);
  });

  it("ranks id-less rows (the definition admits them) and dedups ids case-insensitively", () => {
    // Held attacks: `recencyOrder` explicitly orders rows WITHOUT an id, and
    // `identity.normalize` is lowercase — both are honoured.
    expect(computePlayerRank([scored(undefined, "dink", AT, 6)])?.rating).toBe(6);
    const summary = computePlayerRank([
      scored(ID_A.toUpperCase(), "dink", AT, 9),
      scored(ID_A, "dink", "2026-08-01T11:00:00.000Z", 1),
    ]);
    expect(summary?.scoredAnalysisCount).toBe(1);
    expect(summary?.rating).toBe(9);
  });
});

describe("W06-01 r4 attack: shotType text Postgres refuses", () => {
  it("abstains on a lone UTF-16 surrogate (jsonb input fails: 22P02, no row can be stored)", () => {
    // JSON.stringify("\ud800") === '"\\ud800"'; `select '"\\ud800"'::jsonb`
    // raises SQLSTATE 22P02 ("invalid input syntax for type json") on
    // PostgreSQL 16 — pinned in
    // supabase/functions/api/__wf__/attack_w06_01_r4.test.ts.  The Edge
    // admits it (trimmed non-empty, 1 code unit ≤ 64) and forwards it to
    // apply_synced_shot(jsonb); Postgres' own jsonb input refuses the text,
    // so no plane that goes through jsonb can store the row the device
    // ranks (what PostgREST's decoder does with the escape before Postgres
    // sees it is not pinned here).
    for (const shotType of ["\ud800", "dink\udc00", "\ud83d"]) {
      expect(shotType.trim().length > 0 && shotType.length <= 64).toBe(true);
      expect(
        computePlayerRank([scored(ID_A, shotType, AT, 6)]),
        JSON.stringify(shotType),
      ).toBeNull();
    }
  });
});

describe("W06-01 r4 attack: capture-instant grammar edges", () => {
  it("refuses what the Edge grammar refuses and admits what it admits", () => {
    const cases: Array<[string, boolean]> = [
      ["2026-06-30T23:59:60Z", false], // leap second
      ["2026-08-01T24:00:00Z", false], // 24:00 (Date.parse admits, calendar round-trip fails)
      ["0000-01-01T00:00:00Z", false],
      ["2026-08-01T10:00:00z", false], // lowercase z
      ["2026-08-01T10:00:00+00:00", false],
      ["2026-08-01T10:00:00Z ", false], // trailing space
      [" 2026-08-01T10:00:00Z", false],
      ["2026-08-01T10:00:00.Z", false], // empty fraction
      ["2026-08-01T10:00:00Z", true], // iOS ISO8601DateFormatter default
      ["2026-08-01T10:00:00.1Z", true],
      ["2026-08-01T10:00:00.123456789Z", true],
      ["2026-12-31T23:59:59Z", true],
      ["2028-02-29T00:00:00Z", true], // leap day
      ["2100-02-29T00:00:00Z", false], // not a leap year (and beyond the bound)
    ];
    for (const [text, admitted] of cases) {
      const edge = EDGE_ISO_RE.test(text) && !Number.isNaN(Date.parse(text));
      const summary = computePlayerRank([scored(ID_A, "dink", text, 6)]);
      expect(summary !== null, `${JSON.stringify(text)} edge-grammar=${edge}`).toBe(admitted);
    }
  });

  it("the golden fixture exercises the production capture shape (no fraction, `…SSZ`)", () => {
    // apps/mobile/ios/LocalPods/PickleNative/Sources/ClipMediaStore.swift
    // stamps `capturedAtIso` with `ISO8601DateFormatter().string(from:)`,
    // whose default options carry NO fractional seconds.  A fixture that
    // only ever ranks `.000Z` texts never checks Edge/SQL/mobile against the
    // shape production actually sends (and the technique's reported
    // `capturedAt` text differs from the SQL plane's canonical text there).
    const texts = [
      ...fixture.cases.flatMap((c) => c.analyses.map((a) => a.capturedAt)),
      ...fixture.replays.flatMap((c) => c.analyses.map((a) => a.capturedAt)),
    ];
    const noFraction = texts.filter((t) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(t));
    expect(noFraction.length, "fixture rows shaped like the iOS capture stamp").toBeGreaterThan(0);
  });
});

describe("W06-01 r4 attack: single source of truth and immutability from a consumer", () => {
  it("re-exported rank constants ARE the definition's objects, not copies", () => {
    expect(PLAYER_RANK_TIERS).toBe(SCORING_DEFINITION.components.tiers.thresholds);
    expect(RANK_FORM_WINDOW).toBe(SCORING_DEFINITION.components.formWindow.size);
    expect(RANK_CONFIDENCE_CAP).toBe(SCORING_DEFINITION.components.confidenceWeight.cap);
    expect(SCORING_DEFINITION.components.recencyWeights.weights).toHaveLength(RANK_FORM_WINDOW);
  });

  it("a consumer cannot bend the weights, thresholds or bounds at runtime", () => {
    // A consumer that widens the readonly types (the way a JS caller or a
    // `Mutable<>` helper would) must still be refused by the frozen objects.
    type Writable<T> = { -readonly [K in keyof T]: Writable<T[K]> };
    const components = SCORING_DEFINITION.components as Writable<
      typeof SCORING_DEFINITION.components
    >;
    const weights: number[] = components.recencyWeights.weights;
    expect(() => {
      weights[0] = 100;
    }).toThrow(TypeError);
    expect(() => weights.push(0)).toThrow(TypeError);
    const thresholds: Array<{ minRating: number }> = components.tiers.thresholds;
    expect(() => {
      const bronze = thresholds[0];
      if (bronze) bronze.minRating = 9;
    }).toThrow(TypeError);
    const bounds: { min: string } = components.countability.capturedAt;
    expect(() => {
      bounds.min = "1900-01-01T00:00:00.000Z";
    }).toThrow(TypeError);
    const excluded: string[] = components.countability.shotType.excludedCodePoints;
    expect(() => excluded.pop()).toThrow(TypeError);
    // and the rank still computes from the untouched definition
    expect(computePlayerRank([scored(ID_A, "dink", AT, 6)])?.rating).toBe(6);
  });
});
