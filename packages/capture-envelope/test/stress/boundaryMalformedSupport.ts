import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EnvelopeStatus } from "@pickle/shared-types";
import type { CaptureEnvelopeMeasurements } from "../../src/envelope.js";
import type { DimensionThreshold } from "../../src/thresholds.js";
import {
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
  G08_LABEL_SCHEMA_VERSION,
} from "../../src/g08LabelSchema.js";

/**
 * Shared support for the boundary/malformed-input stress campaign
 * (`lens: boundary-malformed`). Every generated input is a pure function of
 * a 32-bit seed so any row of the results table replays with
 * `STRESS_SEED=<seed> STRESS_ITER=1`.
 *
 * Scale is controlled by env:
 *   STRESS_ITER        iterations per generator (default: small, suite-safe)
 *   STRESS_SEED        base seed (default 20260905)
 *   STRESS_OUT         when set, the JSON results table is written here
 *   STRESS_MEDIA_ITER  iterations for the ffmpeg-backed media campaign
 */

export const DEFAULT_BASE_SEED = 20260905;

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export const STRESS_ITER = envInt("STRESS_ITER", 150);
export const STRESS_MEDIA_ITER = envInt("STRESS_MEDIA_ITER", 8);
export const STRESS_SEED = envInt("STRESS_SEED", DEFAULT_BASE_SEED);
export const STRESS_OUT = process.env.STRESS_OUT;

/** mulberry32 — small, fast, fully determined by its 32-bit seed. */
export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  intBetween(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(items.length)]!;
  }

  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) out[index] = this.int(256);
    return out;
  }
}

export type Outcome = "HELD" | "BROKEN";

export interface ResultRow {
  seed: number;
  generator: string;
  kind: string;
  outcome: Outcome;
  detail: string;
}

export class ResultTable {
  readonly rows: ResultRow[] = [];

  record(row: ResultRow): void {
    this.rows.push(row);
  }

  broken(): ResultRow[] {
    return this.rows.filter((row) => row.outcome === "BROKEN");
  }

  brokenSeeds(kindPrefix?: string): number[] {
    return this.broken()
      .filter((row) => kindPrefix === undefined || row.kind.startsWith(kindPrefix))
      .map((row) => row.seed);
  }

  countByKind(): Record<string, { held: number; broken: number }> {
    const out: Record<string, { held: number; broken: number }> = {};
    for (const row of this.rows) {
      const bucket = (out[row.kind] ??= { held: 0, broken: 0 });
      if (row.outcome === "HELD") bucket.held += 1;
      else bucket.broken += 1;
    }
    return out;
  }
}

export function writeTable(path: string | undefined, name: string, table: ResultTable): void {
  if (!path) return;
  const target = path.endsWith(".json")
    ? path.replace(/\.json$/, `.${name}.json`)
    : `${path}.${name}.json`;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `${JSON.stringify(
      {
        campaign: name,
        baseSeed: STRESS_SEED,
        iterations: STRESS_ITER,
        executed: table.rows.length,
        byKind: table.countByKind(),
        brokenSeeds: table.brokenSeeds(),
        rows: table.rows,
      },
      null,
      1,
    )}\n`,
  );
}

/** JSON-safe rendering of arbitrary values (bigint, undefined, cycles, -0). */
export function describeValue(value: unknown, depth = 0): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return String(value);
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 37)}…(len ${value.length})` : value;
    return JSON.stringify(shown);
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "function") return "function";
  if (value instanceof Error) return `${value.name}: ${value.message.slice(0, 120)}`;
  if (typeof value === "symbol") return value.toString();
  if (depth > 2) return Array.isArray(value) ? "[…]" : "{…}";
  if (Array.isArray(value)) {
    return `[${value
      .slice(0, 4)
      .map((item) => describeValue(item, depth + 1))
      .join(",")}${value.length > 4 ? `,…(${value.length})` : ""}]`;
  }
  const entries = Object.keys(value as object).slice(0, 6);
  return `{${entries
    .map((key) => `${key}:${describeValue((value as Record<string, unknown>)[key], depth + 1)}`)
    .join(",")}}`;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** True when a value could have arrived through JSON.parse (no bigint/function/symbol/undefined). */
export function isJsonReachable(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return !Number.isNaN(value);
    case "object":
      return Array.isArray(value)
        ? value.every((item) => isJsonReachable(item))
        : Object.values(value as Record<string, unknown>).every((item) => isJsonReachable(item));
    default:
      return false;
  }
}

/** Reference semantics for one dimension: only a finite number is a measurement. */
export function referenceStatus(value: unknown, threshold: DimensionThreshold): EnvelopeStatus {
  if (!isFiniteNumber(value)) return "NOT_MEASURED";
  const inBand = (band: { min?: number; max?: number }): boolean =>
    !(band.min !== undefined && value < band.min) && !(band.max !== undefined && value > band.max);
  if (inBand(threshold.supported)) return "SUPPORTED";
  if (inBand(threshold.degraded)) return "DEGRADED";
  return "UNSUPPORTED";
}

export const MEASUREMENT_KEYS = [
  "frameWidthPx",
  "frameHeightPx",
  "avgFrameRateFps",
  "brightnessMeanLuma",
  "brightnessStdLuma",
  "laplacianVarianceMedian",
  "meanAbsFrameDiff",
  "denoiseSurvivalRatio",
  "clippedPixelFraction",
  "contrastNormalizedFrameDiff",
  "frameIntervalCv",
  "clipDurationMs",
  "playerPixelHeightFraction",
  "playerMeanJointVisibility",
] as const satisfies ReadonlyArray<keyof CaptureEnvelopeMeasurements>;

export type MeasurementKey = (typeof MEASUREMENT_KEYS)[number];

export const ENVELOPE_STATUSES: ReadonlySet<string> = new Set([
  "SUPPORTED",
  "DEGRADED",
  "UNSUPPORTED",
  "NOT_MEASURED",
]);

/** Next representable double above/below `value` (boundary probing). */
export function nextAfter(value: number, up: boolean): number {
  if (!Number.isFinite(value)) return value;
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buffer = new DataView(new ArrayBuffer(8));
  buffer.setFloat64(0, value);
  let bits = buffer.getBigUint64(0);
  bits += value > 0 === up ? 1n : -1n;
  buffer.setBigUint64(0, bits);
  return buffer.getFloat64(0);
}

/** In-type numeric palette: everything a `number | null` field may legally hold. */
export function inTypeNumber(rng: SeededRng, threshold: DimensionThreshold): number | null {
  const anchors: number[] = [];
  for (const band of [threshold.supported, threshold.degraded]) {
    if (band.min !== undefined) anchors.push(band.min);
    if (band.max !== undefined) anchors.push(band.max);
  }
  switch (rng.int(14)) {
    case 0:
      return null;
    case 1:
      return Number.NaN;
    case 2:
      return rng.bool() ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    case 3:
      return -0;
    case 4:
      return rng.pick(anchors);
    case 5:
      return nextAfter(rng.pick(anchors), rng.bool());
    case 6:
      return rng.bool() ? Number.MAX_VALUE : -Number.MAX_VALUE;
    case 7:
      return rng.bool() ? Number.MIN_VALUE : -Number.MIN_VALUE;
    case 8:
      return rng.bool() ? Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER + 2;
    case 9:
      return -rng.next() * 1000;
    case 10:
      return 0;
    case 11:
      return rng.next() * 1e6;
    default: {
      const anchor = rng.pick(anchors);
      return anchor * (0.5 + rng.next());
    }
  }
}

/** Off-type palette: values a `number | null` slot can only hold via an untyped boundary. */
export function offTypeValue(rng: SeededRng): unknown {
  switch (rng.int(12)) {
    case 0:
      return undefined;
    case 1:
      return String(rng.int(1000));
    case 2:
      return "";
    case 3:
      return "NaN";
    case 4:
      return rng.bool();
    case 5:
      return {};
    case 6:
      return [];
    case 7:
      return [rng.int(1000)];
    case 8:
      return BigInt(rng.int(1000));
    case 9: {
      const fixed = rng.int(1000);
      return { valueOf: () => fixed };
    }
    case 10:
      return "1e400";
    default:
      return () => 0;
  }
}

export const PATH_TRAVERSALS = [
  "../../../etc/passwd",
  "/etc/passwd",
  "datasets/../../../../etc/shadow",
  "..\\..\\windows\\system32\\config\\sam",
  "datasets/%2e%2e/%2e%2e/etc/passwd",
  "clip.mp4\u0000.txt",
  "\u0000",
  "file:///etc/passwd",
  "http://127.0.0.1:9/latest/meta-data",
  "-i",
  "-version",
  "concat:/etc/passwd|/etc/hostname",
  "datasets/paddle-bench/bundles/x/../../../secret.mp4",
  "C:\\clips\\clip.mp4",
  "~/clip.mp4",
  "$HOME/clip.mp4",
  "`id`.mp4",
  "$(id).mp4",
  "clip.mp4;rm -rf /",
  "clip.mp4 | cat /etc/passwd",
] as const;

export const UNICODE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u00e9", "e\u0301"],
  ["\u00c5", "A\u030a"],
  ["\ufb01", "fi"],
  ["\u2126", "\u03a9"],
  ["\u1e9b\u0323", "\u1e69"],
  ["\u212b", "\u00c5"],
  ["\u0130", "I\u0307"],
  ["\uff21", "A"],
];

const NUL = "\u0000";
const ZWJ = "\u200d";
const FAMILY_EMOJI = `\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}${ZWJ}\u{1f466}`;

/** Strings that separate byte, code-point and grapheme accounting. */
export function boundaryString(rng: SeededRng): string {
  switch (rng.int(16)) {
    case 0:
      return "";
    case 1:
      return " ";
    case 2:
      return "\t\n\r";
    case 3:
      return NUL;
    case 4:
      return `valid${NUL}hidden`;
    case 5:
      return "a".repeat(65_536);
    case 6:
      return "a".repeat(65_537);
    case 7:
      return "\u00e9".repeat(32_768);
    case 8:
      return "\u{1f600}".repeat(16_384);
    case 9:
      return FAMILY_EMOJI.repeat(4_096);
    case 10:
      return "\ud800";
    case 11:
      return "\udfff\ud800";
    case 12:
      return rng.pick(UNICODE_PAIRS)[rng.int(2)]!;
    case 13:
      return "\ufeff".repeat(rng.intBetween(1, 3));
    case 14:
      return "x".repeat(1_048_576);
    default:
      return rng.pick(PATH_TRAVERSALS);
  }
}

export const FUTURE_SCHEMA_VERSIONS = [
  "g08-f22-evidence-labels-v2",
  "g08-f22-evidence-labels-v1.1",
  "g08-f22-evidence-labels-v10",
  "g08-f22-evidence-labels-v1 ",
  " g08-f22-evidence-labels-v1",
  "G08-F22-EVIDENCE-LABELS-V1",
  "g08-f22-evidence-labels-v1\u0000",
  "g08-f22-evidence-labels-v0",
  `g08-f22-evidence-labels-v1${ZWJ}`,
  "g08-f22-evidence-labels-v\u2081",
] as const;

export interface LabelTemplate {
  labelId: string;
  candidateId: string | null;
  clip: string;
  windowMs: { startMs: number; durationMs: number };
  sessionKey: string;
  family: string;
  capture: string;
  downstream: string;
  annotatorKind: string;
  annotator: string;
  labeledAtIso: string;
  notes: string;
  supersedesLabelId?: string;
}

export function validLabel(rng: SeededRng, index: number): LabelTemplate {
  const capture = rng.pick(G08_CAPTURE_LABELS);
  return {
    labelId: `g08-label-${String(index).padStart(4, "0")}`,
    candidateId: rng.bool() ? null : `g08-${rng.pick(G08_BYPASS_FAMILIES)}-${rng.int(99)}`,
    clip: `datasets/paddle-bench/bundles/b${rng.int(50)}/clip.mp4`,
    windowMs: { startMs: rng.int(60_000), durationMs: rng.intBetween(1, 30_000) },
    sessionKey: `s${rng.int(12)}`,
    family: rng.pick(G08_BYPASS_FAMILIES),
    capture,
    downstream: rng.pick(G08_DOWNSTREAM_OUTCOMES),
    annotatorKind: "human",
    annotator: `reviewer-${rng.int(5)}`,
    labeledAtIso: new Date(1_700_000_000_000 + rng.int(1e9) * 100).toISOString(),
    notes: capture === "UNSAFE" || capture === "AMBIGUOUS" ? "boundary case notes" : "",
  };
}

export function validLabelFile(
  rng: SeededRng,
  count: number,
): {
  schemaVersion: string;
  provenance: string;
  labels: LabelTemplate[];
} {
  const labels: LabelTemplate[] = [];
  for (let index = 0; index < count; index += 1) labels.push(validLabel(rng, index));
  return {
    schemaVersion: G08_LABEL_SCHEMA_VERSION,
    provenance: "seeded synthetic stress fixture — not a human labeling session",
    labels,
  };
}

/** Builds an object whose own keys include prototype-pollution vectors. */
export function withPollutionKeys(
  rng: SeededRng,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const marker = `polluted_${rng.int(1e6)}`;
  const vectors: Array<[string, unknown]> = [
    ["__proto__", { [marker]: true }],
    ["constructor", { prototype: { [marker]: true } }],
    ["prototype", { [marker]: true }],
    ["toString", "not-a-function"],
    ["hasOwnProperty", 1],
    ["valueOf", null],
  ];
  const chosen = vectors[rng.int(vectors.length)]!;
  const literal = `{${JSON.stringify(chosen[0])}:${JSON.stringify(chosen[1])}}`;
  const parsed = JSON.parse(literal) as Record<string, unknown>;
  return Object.assign(parsed, base);
}

export function isPrototypeClean(): boolean {
  const probe: Record<string, unknown> = {};
  for (const key of Object.keys(Object.prototype)) if (key.startsWith("polluted_")) return false;
  return Object.getOwnPropertyNames(probe).length === 0;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number") {
      if (Number.isNaN(item)) return "__NaN__";
      if (item === Number.POSITIVE_INFINITY) return "__+Inf__";
      if (item === Number.NEGATIVE_INFINITY) return "__-Inf__";
      if (Object.is(item, -0)) return "__-0__";
    }
    if (typeof item === "bigint") return `__bigint_${item}__`;
    if (typeof item === "function") return "__function__";
    if (item === undefined) return "__undefined__";
    return item;
  });
}
