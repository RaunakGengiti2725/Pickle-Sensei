/**
 * W06-01 ADVERSARY (round 4, candidate devin/pp/w06-01/impl-r4 @ 61206685)
 *
 * An INDEPENDENT oracle of the nine documented scoring components, written
 * in exact integer/BigInt arithmetic from the prose of `SCORING_DEFINITION`
 * alone (no call into `computePlayerRank`), then driven over
 *   1. every golden fixture case and replay case (the fixture's `expected`
 *      must equal what the definition text says), and
 *   2. thousands of seeded random inputs that concentrate on the failure
 *      boundaries the candidate claims to have closed: same-instant ties,
 *      sub-millisecond fractions, three-decimal and exponent-form scores,
 *      duplicate ids with conflicting content, mixed-case ids, rows Edge or
 *      SQL refuse, id-less rows, and shuffled arrival orders.
 *
 * A failing test is a confirmed break; a passing test is an attack that did
 * not break anything.  The candidate's code, fixture and tests are untouched.
 */
import { describe, expect, it } from "vitest";
import golden from "../../fixtures/scoring/player-rank.golden.json" with { type: "json" };
import { computePlayerRank, type PlayerRankAnalysisInput } from "../playerRank.js";
import {
  SCORING_DEFINITION,
  SCORING_DEFINITION_VERSION,
  type PlayerRankGoldenFixture,
} from "../scoringDefinition.js";

const fixture: PlayerRankGoldenFixture = golden;
const C = SCORING_DEFINITION.components;

// ─── Independent oracle ──────────────────────────────────────────────────────

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

interface Instant {
  wholeMs: number;
  fraction: string;
}

function parseInstant(text: string): Instant | null {
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1) return null;
  if (back.getUTCDate() !== day) return null;
  return { wholeMs: ms, fraction: frac ?? "" };
}

/** Edge plane: `Date.parse` keeps the first three fraction digits. */
function edgeMillis(i: Instant): number {
  return i.wholeMs + Number(i.fraction.slice(0, 3).padEnd(3, "0"));
}

/** C rint() — round half to even. */
function rint(x: number): number {
  const f = Math.floor(x);
  const r = x - f;
  if (r < 0.5) return f;
  if (r > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** SQL plane: timestamptz = whole seconds + rint(strtod(fraction) * 1e6). */
function sqlMicros(i: Instant): bigint {
  const frac = i.fraction === "" ? 0 : rint(Number(`0.${i.fraction}`) * 1e6);
  return BigInt(i.wholeMs) * 1000n + BigInt(frac);
}

function boundInstant(text: string): Instant {
  const instant = parseInstant(text);
  if (instant === null) throw new Error(`definition bound is not an instant: ${text}`);
  return instant;
}
const MIN = boundInstant(C.countability.capturedAt.min);
const MAX = boundInstant(C.countability.capturedAt.maxExclusive);

function everyPlaneAdmits(i: Instant): boolean {
  const edgeOk = edgeMillis(i) >= edgeMillis(MIN) && edgeMillis(i) < edgeMillis(MAX);
  const sqlOk = sqlMicros(i) >= sqlMicros(MIN) && sqlMicros(i) < sqlMicros(MAX);
  return edgeOk && sqlOk;
}

function shotTypeOk(shotType: unknown): shotType is string {
  return (
    typeof shotType === "string" &&
    shotType.trim().length > 0 &&
    shotType.length <= C.countability.shotType.maxLength &&
    !C.countability.shotType.excludedCodePoints.some((cp) => shotType.includes(cp))
  );
}

/** Storable = the sync ingress AND every `public.shots` check admit the row. */
function storable(row: PlayerRankAnalysisInput): Instant | null {
  if (row.resultKind === "scored") {
    if (typeof row.overallScore !== "number" || !Number.isFinite(row.overallScore)) return null;
    if (row.overallScore < 0 || row.overallScore > 10) return null;
  } else if (row.resultKind === "low_confidence") {
    if (row.overallScore !== null) return null;
  } else {
    return null;
  }
  if (!shotTypeOk(row.shotType)) return null;
  if (row.source !== undefined && row.source !== "real") return null;
  if (typeof row.capturedAt !== "string") return null;
  const instant = parseInstant(row.capturedAt);
  if (instant === null || !everyPlaneAdmits(instant)) return null;
  return instant;
}

/** Exact decimal text of a JS number (what JSON carries), expanded from any
 * exponent form, as [integerDigits, fractionDigits]. */
function decimalDigits(n: number): [string, string] {
  const text = String(n);
  const eIndex = text.indexOf("e");
  if (eIndex === -1) {
    const [whole = "0", frac = ""] = text.split(".");
    return [whole, frac];
  }
  const mantissa = text.slice(0, eIndex);
  const exponent = Number(text.slice(eIndex + 1));
  const [mWhole = "0", mFrac = ""] = mantissa.split(".");
  const digits = mWhole + mFrac;
  const pointAt = mWhole.length + exponent;
  if (pointAt <= 0) return ["0", "0".repeat(-pointAt) + digits];
  if (pointAt >= digits.length) return [digits + "0".repeat(pointAt - digits.length), ""];
  return [digits.slice(0, pointAt), digits.slice(pointAt)];
}

/** numeric(4,2): round the decimal text half away from zero to hundredths. */
function hundredthsOf(score: number): bigint {
  const [whole, frac] = decimalDigits(score);
  const kept = frac.slice(0, 2).padEnd(2, "0");
  const rest = frac.slice(2);
  const bump = rest.length > 0 && rest.charCodeAt(0) >= 0x35 ? 1n : 0n;
  return BigInt(whole) * 100n + BigInt(kept) + bump;
}

/** round half away from zero of a non-negative rational num/den. */
function roundDiv(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Counted {
  h: bigint;
  us: bigint;
  id: string;
  text: string;
  shotType: string;
}

interface OracleTechnique {
  shotType: string;
  score: number;
  capturedAt: string;
  sampledCount: number;
}

interface OracleSummary {
  definitionVersion: string;
  rating: number;
  tier: string;
  tierLabel: string;
  division: number;
  divisionLabel: string;
  techniqueCount: number;
  scoredAnalysisCount: number;
  techniques: OracleTechnique[];
  nextTier: { key: string; label: string; minRating: number; pointsNeeded: number } | null;
}

const TIERS = C.tiers.thresholds;

function oracle(rows: readonly PlayerRankAnalysisInput[]): OracleSummary | null {
  const held = new Set<string>();
  const buckets = new Map<string, Counted[]>();
  let scoredCount = 0;
  for (const row of rows) {
    const instant = storable(row);
    if (instant === null) continue;
    const id = (row.id ?? "").toLowerCase();
    if (id !== "") {
      if (held.has(id)) continue;
      held.add(id);
    }
    if (row.resultKind !== "scored") continue;
    scoredCount += 1;
    const counted: Counted = {
      h: hundredthsOf(row.overallScore as number),
      us: sqlMicros(instant),
      id,
      text: row.capturedAt,
      shotType: row.shotType,
    };
    const bucket = buckets.get(row.shotType) ?? [];
    bucket.push(counted);
    buckets.set(row.shotType, bucket);
  }
  if (buckets.size === 0) return null;

  const weights = C.recencyWeights.weights.map(BigInt);
  const techniques: Array<OracleTechnique & { confidence: bigint; scoreH: bigint }> = [];
  for (const [shotType, bucket] of buckets) {
    bucket.sort((a, b) => {
      if (a.us !== b.us) return a.us > b.us ? -1 : 1;
      if (a.id !== b.id) return cmpText(b.id, a.id);
      if (a.text !== b.text) return cmpText(b.text, a.text);
      return a.h === b.h ? 0 : a.h > b.h ? -1 : 1;
    });
    const window = bucket.slice(0, C.formWindow.size);
    let num = 0n;
    let den = 0n;
    window.forEach((row, index) => {
      const w = weights[index];
      if (w === undefined) throw new Error("weight missing");
      num += w * row.h;
      den += w;
    });
    const scoreH = roundDiv(num, den);
    let latest = window[0];
    if (latest === undefined) throw new Error("empty bucket");
    for (const row of bucket) {
      if (row.us > latest.us || (row.us === latest.us && cmpText(row.text, latest.text) > 0)) {
        latest = row;
      }
    }
    const count = BigInt(bucket.length);
    const cap = BigInt(C.confidenceWeight.cap);
    techniques.push({
      shotType,
      score: Number(scoreH) / 100,
      capturedAt: latest.text,
      sampledCount: window.length,
      confidence: count < cap ? count : cap,
      scoreH,
    });
  }
  techniques.sort((a, b) => {
    if (a.scoreH !== b.scoreH) return a.scoreH > b.scoreH ? -1 : 1;
    return cmpText(a.shotType, b.shotType);
  });
  let num = 0n;
  let den = 0n;
  for (const t of techniques) {
    num += t.confidence * t.scoreH;
    den += t.confidence;
  }
  const ratingH = roundDiv(num, den);
  let tierIndex = 0;
  TIERS.forEach((tier, index) => {
    if (ratingH >= BigInt(Math.round(tier.minRating * 100))) tierIndex = index;
  });
  const tier = TIERS[tierIndex];
  if (tier === undefined) throw new Error("tier missing");
  const next = TIERS[tierIndex + 1] ?? null;
  const floorH = BigInt(Math.round(tier.minRating * 100));
  const ceilingH = BigInt(Math.round((next?.minRating ?? C.tiers.topOfScale) * 100));
  const span = ceilingH - floorH;
  const into = ratingH - floorH;
  const division = 3n * into >= 2n * span ? 1 : 3n * into >= span ? 2 : 3;
  return {
    definitionVersion: SCORING_DEFINITION_VERSION,
    rating: Number(ratingH) / 100,
    tier: tier.key,
    tierLabel: tier.label,
    division,
    divisionLabel: division === 1 ? "I" : division === 2 ? "II" : "III",
    techniqueCount: techniques.length,
    scoredAnalysisCount: scoredCount,
    techniques: techniques.map(({ confidence: _c, scoreH: _s, ...t }) => t),
    nextTier: next
      ? {
          key: next.key,
          label: next.label,
          minRating: next.minRating,
          pointsNeeded: Number(BigInt(Math.round(next.minRating * 100)) - ratingH) / 100,
        }
      : null,
  };
}

function wire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

// ─── Seeded generator ────────────────────────────────────────────────────────

function rng(seed: number): () => number {
  let s = (Math.imul(seed, 0x9e3779b9) ^ 0x85ebca6b) >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  for (let i = 0; i < 16; i += 1) next(); // xorshift32 warm-up: small seeds start tiny
  return next;
}

function pick<T>(r: () => number, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error("empty pick");
  return item;
}

function uuidFrom(r: () => number): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(r() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${out.slice(20)}`;
}

const SHOT_TYPES = [
  "dink",
  "drive",
  "Dink",
  "serve",
  "serve ",
  "_lob",
  "é",
  "e\u0301",
  "x".repeat(64),
];

function randomInstant(r: () => number): string {
  const roll = r();
  if (roll < 0.04) return pick(r, ["2000-01-01T00:00:00Z", "1999-12-31T23:59:59.9999995Z"]);
  if (roll < 0.08) return pick(r, ["2099-12-31T23:59:59.999Z", "2099-12-31T23:59:59.9999995Z"]);
  if (roll < 0.11)
    return pick(r, ["2026-08-01T10:00:00", "2026-08-01T10:00:00+00:00", "2026-02-30T10:00:00Z"]);
  const base = Date.UTC(2026, 7, 1, 10, 0, 0);
  const second = Math.floor(r() * 4) * 1000; // few distinct seconds → many ties
  const whole = new Date(base + second).toISOString().slice(0, 19);
  const shape = r();
  if (shape < 0.25) return `${whole}Z`; // iOS ISO8601DateFormatter shape
  if (shape < 0.5) return `${whole}.${String(Math.floor(r() * 1000)).padStart(3, "0")}Z`;
  const digits = 1 + Math.floor(r() * 9);
  let frac = "";
  for (let i = 0; i < digits; i += 1) frac += String(Math.floor(r() * 10));
  if (r() < 0.3 && digits >= 7) frac = `${frac.slice(0, 6)}5${frac.slice(7)}`; // half-way µs
  return `${whole}.${frac}Z`;
}

function randomScore(r: () => number): number {
  const roll = r();
  if (roll < 0.35) return Math.floor(r() * 1001) / 100;
  if (roll < 0.6) return Math.floor(r() * 10001) / 1000; // three decimals → half ties
  if (roll < 0.75) return r() * 10; // arbitrary double
  if (roll < 0.8) return pick(r, [0, 10, 1e-7, 5e-7, 9.995, 6.005, 0.1 + 0.2]);
  if (roll < 0.9) return pick(r, [Number.NaN, 10.001, -0.001, Number.POSITIVE_INFINITY]);
  return Math.floor(r() * 11);
}

function randomRows(seed: number): PlayerRankAnalysisInput[] {
  const r = rng(seed);
  const n = 1 + Math.floor(r() * 14);
  const rows: PlayerRankAnalysisInput[] = [];
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    let id: string | undefined = uuidFrom(r);
    if (ids.length > 0 && r() < 0.25) id = pick(r, ids);
    if (r() < 0.15 && id !== undefined) id = id.toUpperCase();
    if (r() < 0.08) id = undefined;
    if (id !== undefined) ids.push(id);
    const kind = r() < 0.85 ? "scored" : r() < 0.7 ? "low_confidence" : "partial";
    const row: PlayerRankAnalysisInput = {
      shotType: pick(r, SHOT_TYPES),
      overallScore: kind === "scored" ? randomScore(r) : r() < 0.85 ? null : 5,
      resultKind: kind,
      capturedAt: randomInstant(r),
    };
    if (id !== undefined) row.id = id;
    const src = r();
    if (src < 0.6) row.source = "real";
    else if (src < 0.68) row.source = "fixture";
    rows.push(row);
  }
  return rows;
}

function shuffled<T>(items: readonly T[], r: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) throw new Error("shuffle");
    out[i] = b;
    out[j] = a;
  }
  return out;
}

// ─── Attacks ─────────────────────────────────────────────────────────────────

describe("W06-01 r4 attack: golden fixture vs an independent exact-arithmetic oracle", () => {
  it("every ranked/abstaining case's `expected` is what the definition text computes", () => {
    for (const goldenCase of fixture.cases) {
      expect(wire(oracle(goldenCase.analyses)), goldenCase.id).toEqual(goldenCase.expected);
    }
  });

  it("every replay case's `expected` is what first-storable-arrival computes", () => {
    for (const replay of fixture.replays) {
      expect(wire(oracle(replay.analyses)), replay.id).toEqual(replay.expected);
    }
  });

  it("every rejected input is no evidence for the oracle and for the candidate alike", () => {
    for (const rejected of fixture.rejectedInputs) {
      expect(oracle([rejected.analysis]), rejected.id).toBeNull();
      expect(computePlayerRank([rejected.analysis]), rejected.id).toBeNull();
    }
  });
});

describe("W06-01 r4 attack: seeded random inputs at the failure boundaries", () => {
  it("computePlayerRank equals the oracle on 3000 random histories (ties, µs, half-ties, replays)", () => {
    const mismatches: string[] = [];
    let ranked = 0;
    let orderSensitive = 0;
    for (let seed = 1; seed <= 3000; seed += 1) {
      const rows = randomRows(seed);
      const actual = wire(computePlayerRank(rows));
      const expected = wire(oracle(rows));
      if (actual !== null) ranked += 1;
      if (JSON.stringify(actual) !== JSON.stringify(wire(computePlayerRank([...rows].reverse())))) {
        orderSensitive += 1; // replayed ids with conflicting content — by design
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(
          `seed ${seed}\n  rows     = ${JSON.stringify(rows)}\n  actual   = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(expected)}`,
        );
      }
    }
    expect(
      mismatches,
      `${mismatches.length} mismatches:\n${mismatches.slice(0, 5).join("\n")}`,
    ).toEqual([]);
    // Non-vacuity: most histories rank, and the replay boundary is reached.
    expect(ranked).toBeGreaterThan(2000);
    expect(orderSensitive).toBeGreaterThan(100);
  });

  it("without replayed ids, every arrival order of a random history ranks identically", () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 1500; seed += 1) {
      const rows = randomRows(seed);
      const seen = new Set<string>();
      const unique = rows.filter((row) => {
        const id = (row.id ?? "").toLowerCase();
        if (id === "") return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const baseline = JSON.stringify(wire(computePlayerRank(unique)));
      const r = rng(seed * 7919);
      for (let k = 0; k < 6; k += 1) {
        const other = JSON.stringify(wire(computePlayerRank(shuffled(unique, r))));
        if (other !== baseline) {
          mismatches.push(`seed ${seed}: ${baseline} vs ${other}`);
          break;
        }
      }
    }
    expect(mismatches, mismatches.slice(0, 5).join("\n")).toEqual([]);
  });

  it("a history of 5000 same-second rows ranks in well under a second (mobile Home renders it)", () => {
    const r = rng(42);
    const rows: PlayerRankAnalysisInput[] = [];
    for (let i = 0; i < 5000; i += 1) {
      rows.push({
        id: uuidFrom(r),
        shotType: pick(r, SHOT_TYPES),
        overallScore: randomScore(r),
        resultKind: "scored",
        capturedAt: "2026-08-01T10:00:00Z",
        source: "real",
      });
    }
    const started = performance.now();
    const summary = computePlayerRank(rows);
    const elapsed = performance.now() - started;
    expect(summary).not.toBeNull();
    expect(wire(summary)).toEqual(wire(oracle(rows)));
    expect(elapsed).toBeLessThan(1000);
  });
});
