import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Shared plumbing for the boundary/malformed-input stress campaigns.
 *
 * Every campaign iteration is replayable from (STRESS_SEED, index): the
 * per-iteration seed is derived deterministically, the generator only reads
 * from the seeded RNG, and each row of the JSON result table records the seed
 * that produced it. Replay a single seed with STRESS_ONLY_SEED=<seed>.
 *
 * Env knobs (all optional):
 *   STRESS_ITER       iterations per campaign (campaigns scale their default)
 *   STRESS_SEED       campaign base seed (default 20260904)
 *   STRESS_ONLY_SEED  run exactly one iteration seed (for minimisation/replay)
 *   STRESS_OUT        directory for JSON result tables
 *                     (default <repo>/artifacts/stress/pkg-database-boundary-malformed)
 */

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = join(PACKAGE_ROOT, "migrations");

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** STRESS_ITER scaled per campaign: `STRESS_ITER * scale`, or `fallback`. */
export function iterations(fallback: number, scale = 1): number {
  const iter = process.env["STRESS_ITER"];
  if (iter === undefined || iter === "") return fallback;
  return Math.max(1, Math.round(envInt("STRESS_ITER", fallback) * scale));
}

export const BASE_SEED = envInt("STRESS_SEED", 20260904);

/** FNV-1a 32-bit over a string — stable, dependency-free seed derivation. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function iterationSeed(campaign: string, index: number): number {
  return fnv1a(`${campaign}:${BASE_SEED}:${index}`);
}

/** Seeds to run for a campaign: honours STRESS_ONLY_SEED for replay. */
export function campaignSeeds(campaign: string, count: number): number[] {
  const only = process.env["STRESS_ONLY_SEED"];
  if (only !== undefined && only !== "") return [envInt("STRESS_ONLY_SEED", 0)];
  const seeds: number[] = [];
  for (let i = 0; i < count; i++) seeds.push(iterationSeed(campaign, i));
  return seeds;
}

/** mulberry32 — small, fast, deterministic, good enough for fuzz streams. */
export class Rng {
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

  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty list");
    return items[this.int(0, items.length - 1)] as T;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }

  hex(len: number): string {
    let s = "";
    for (let i = 0; i < len; i++) s += this.int(0, 15).toString(16);
    return s;
  }

  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
  }
}

// ---------------------------------------------------------------------------
// Hostile value pools
// ---------------------------------------------------------------------------

export const KB64 = 64 * 1024;

/** A 64 KiB+ string made of multi-codepoint graphemes (ZWJ family emoji). */
export function graphemeBomb(units: number): string {
  // 👨‍👩‍👧‍👦 = 7 code points / 11 UTF-16 units / 25 UTF-8 bytes / 1 grapheme.
  return "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}".repeat(units);
}

export const UNICODE_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ["e-acute", "\u00e9", "e\u0301"],
  ["angstrom", "\u212b", "\u00c5"],
  ["ohm", "\u2126", "\u03a9"],
  ["ligature-fi", "\ufb01", "fi"],
  ["fullwidth-A", "\uff21", "A"],
  ["hangul", "\uac00", "\u1100\u1161"],
  ["k-sign", "\u212a", "K"],
];

export const PATH_TRAVERSAL: readonly string[] = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "....//....//etc/passwd",
  "/etc/passwd",
  "file:///etc/passwd",
  "slug/../../../root",
  "..%c0%af..%c0%afetc",
  "\u2025/\u2025/etc",
  "C:\\..\\..\\",
];

export const PROTO_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  "__defineGetter__",
  "toString",
  "valueOf",
  "hasOwnProperty",
];

export const NUMERIC_EDGE_JS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.EPSILON,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  -Number.MAX_SAFE_INTEGER - 2,
  2 ** 31,
  2 ** 31 - 1,
  -(2 ** 31),
  -(2 ** 31) - 1,
  2 ** 15,
  -(2 ** 15) - 1,
  2 ** 53,
  2 ** 63,
  2 ** 64,
  1e308,
  -1e308,
  1e-320,
  0.1 + 0.2,
  10.000000000001,
  -0.000000001,
  101,
  100.5,
  1.5,
  -1,
];

export const NUMERIC_EDGE_TEXT: readonly string[] = [
  "NaN",
  "nan",
  "Infinity",
  "-Infinity",
  "inf",
  "-inf",
  "-0",
  "0x10",
  "1e999",
  "-1e999",
  "1e-999",
  "99999999999999999999999999999999",
  "-99999999999999999999999999999999",
  "9223372036854775808",
  "-9223372036854775809",
  "2147483648",
  "-2147483649",
  "32768",
  "-32769",
  "1_000",
  "1,000",
  "١٢٣",
  "1.2.3",
  "+",
  "-",
  ".",
  "",
  " 1",
  "1 ",
  "1\u00002",
  "١",
  "0b101",
  "0o7",
  "true",
  "null",
];

export const CONTROL_STRINGS: readonly string[] = [
  "",
  " ",
  "\t\n\r",
  "\u0000",
  "a\u0000b",
  "\u0000".repeat(16),
  "\u0007\u0008\u001b[31m",
  "\ufeffbom",
  "\u200b\u200c\u200d\u2060",
  "\u202e\u202d\u202a\u202b\u202c",
  "\ud800",
  "\udfff",
  "\ud83d",
  "a\ud800b",
  "\u{10ffff}",
  "\ufffe\uffff",
  "\ufffd",
  "\u0085\u2028\u2029",
  "$1",
  "$1;--",
  "%s%s%s%n",
  "{{7*7}}",
  "${7*7}",
  "'; DROP TABLE shot; --",
  "\\'",
  "''",
  '";',
  "OR 1=1",
  "\\x00",
  "E'\\\\000'",
  "𝕥𝕖𝕩𝕥",
  "ẛ̣",
];

export const MALFORMED_JSON_TEXT: readonly string[] = [
  "",
  "{",
  "}",
  "[",
  "]",
  "{]",
  "[}",
  '{"a":',
  '{"a":1,}',
  "[1,2,]",
  "{'a':1}",
  "{a:1}",
  '{"a" 1}',
  "nul",
  "tru",
  "NaN",
  "Infinity",
  "-Infinity",
  "undefined",
  "01",
  "1.",
  ".5",
  "+1",
  "0x1f",
  '"unterminated',
  '"\\u12"',
  '"\\x41"',
  '"\\u0000"',
  '"\u0000"',
  '{"a":1}{"b":2}',
  '{"a":1} trailing',
  "\ufeff{}",
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  '{"a":1,"a":2}',
  "[".repeat(100000),
  '{"a":'.repeat(20000),
  "1e400",
  "-1e400",
  "123456789012345678901234567890123456789",
  '"' + "\\ud800" + '"',
  '"\\udc00\\ud800"',
];

/** Well-formed JSON documents with hostile shapes. */
export function hostileJsonValue(rng: Rng): unknown {
  const variants: Array<() => unknown> = [
    () => ({}),
    () => [],
    () => null,
    () => "",
    () => 0,
    () => -0,
    () => false,
    () => ({ ["__proto__"]: { polluted: true } }),
    () => JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
    () => JSON.parse('{"constructor":{"prototype":{"polluted":true}}}') as unknown,
    () => ({ [rng.pick(PROTO_KEYS)]: rng.pick(CONTROL_STRINGS) }),
    () => ({ schemaVersion: rng.int(100, 2 ** 31 - 1) }),
    () => ({ schemaVersion: "v99.0.0-future", scoringModelVersion: "9999.0.0" }),
    () => ({ schemaVersion: -1 }),
    () => ({ schemaVersion: null }),
    () => ({ schemaVersion: [] }),
    () => ({ schemaVersion: {} }),
    () => ({ version: rng.pick(NUMERIC_EDGE_TEXT) }),
    () => ({ n: rng.pick(NUMERIC_EDGE_JS) }),
    () => ({ n: String(rng.pick(NUMERIC_EDGE_JS)) }),
    () => [rng.pick(NUMERIC_EDGE_JS), rng.pick(NUMERIC_EDGE_JS)],
    () => ({ s: rng.pick(CONTROL_STRINGS) }),
    () => ({ [rng.pick(CONTROL_STRINGS)]: 1 }),
    () => ({ s: "x".repeat(KB64 + rng.int(1, 1024)) }),
    () => ({ s: graphemeBomb(6000) }),
    () => ({ [rng.pick(PATH_TRAVERSAL)]: rng.pick(PATH_TRAVERSAL) }),
    () => nested(rng.int(1, 200)),
    () => nested(rng.int(1000, 5000)),
    () => Array.from({ length: rng.int(1000, 20000) }, (_, i) => i),
    () => Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, i])),
    () => ({ a: 1, [rng.pick(UNICODE_PAIRS)[1]]: 1, [rng.pick(UNICODE_PAIRS)[2]]: 2 }),
    () => ({ dup: 1, ["dup\u0000"]: 2 }),
  ];
  return rng.pick(variants)();
}

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = i % 2 === 0 ? [v] : { d: v };
  return v;
}

export function hostileString(rng: Rng): string {
  const variants: Array<() => string> = [
    () => rng.pick(CONTROL_STRINGS),
    () => rng.pick(PATH_TRAVERSAL),
    () => rng.pick(PROTO_KEYS),
    () => rng.pick(NUMERIC_EDGE_TEXT),
    () => rng.pick(MALFORMED_JSON_TEXT),
    () => rng.pick(UNICODE_PAIRS)[rng.int(1, 2) as 1 | 2],
    () => "x".repeat(KB64 + rng.int(0, 4096)),
    () => "é".repeat(KB64 / 2 + rng.int(0, 512)),
    () => graphemeBomb(rng.int(2400, 6000)),
    () => "\u0301".repeat(rng.int(100, 10000)),
    () => "\u0000".repeat(rng.int(1, 300)),
    () => "a".repeat(rng.int(1, 80)) + "\u0000" + "b".repeat(rng.int(1, 80)),
    () => rng.pick(CONTROL_STRINGS) + rng.pick(PATH_TRAVERSAL) + rng.pick(CONTROL_STRINGS),
    () => "x".repeat(1024 * 1024),
  ];
  return rng.pick(variants)();
}

// ---------------------------------------------------------------------------
// Outcome classification and reporting
// ---------------------------------------------------------------------------

export type Outcome =
  | "ACCEPTED"
  | "REJECTED_TYPED"
  | "REJECTED_CLIENT"
  | "ANOMALY_WRITE"
  | "ANOMALY_UNTYPED"
  | "ANOMALY_INTERNAL"
  | "ANOMALY_PROPERTY";

export interface ResultRow {
  seed: number;
  index: number;
  campaign: string;
  kind: string;
  input: string;
  outcome: Outcome;
  sqlstate?: string;
  message?: string;
  note?: string;
  durationMs: number;
}

/** SQLSTATE classes that a healthy server must never emit for bad input. */
const INTERNAL_SQLSTATE_CLASSES = new Set(["XX", "58", "57", "53", "08", "F0"]);

/**
 * Codes inside those classes that are still a per-statement, typed rejection:
 * 57014 is a deliberate statement_timeout; 08P01 (protocol_violation) is how
 * the server refuses query text containing a NUL byte — the statement is
 * rejected, the transaction is rolled back and the connection stays usable
 * (every campaign re-checks pool health after such a rejection).
 */
const TOLERATED_CODES = new Set(["57014", "08P01"]);
/**
 * XX000 messages that are really per-statement input rejections: PostgreSQL's
 * `jsonb_recv` uses a bare `elog(ERROR)` (default SQLSTATE XX000) when a client
 * binds a raw Buffer to a jsonb parameter whose first byte is not version 1.
 * The statement is rejected, nothing is written and the connection survives.
 */
const TOLERATED_XX000_MESSAGES = [/^unsupported jsonb version number/];

export interface Classified {
  outcome: Outcome;
  sqlstate?: string;
  message: string;
}

export function classifyError(error: unknown): Classified {
  if (error instanceof pg.DatabaseError && typeof error.code === "string") {
    const cls = error.code.slice(0, 2);
    const toleratedMessage =
      error.code === "XX000" && TOLERATED_XX000_MESSAGES.some((re) => re.test(error.message));
    const internal =
      INTERNAL_SQLSTATE_CLASSES.has(cls) && !TOLERATED_CODES.has(error.code) && !toleratedMessage;
    return {
      outcome: internal ? "ANOMALY_INTERNAL" : "REJECTED_TYPED",
      sqlstate: error.code,
      message: trimMessage(error.message),
    };
  }
  if (error instanceof Error) {
    // node-pg refuses some values before they reach the wire (e.g. symbols,
    // circular objects, oversized buffers). That is a typed client rejection.
    return { outcome: "REJECTED_CLIENT", message: trimMessage(`${error.name}: ${error.message}`) };
  }
  return { outcome: "ANOMALY_UNTYPED", message: trimMessage(String(error)) };
}

export function trimMessage(message: string, max = 240): string {
  const flat = message.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…(${flat.length} chars)` : flat;
}

/** Compact, JSON-safe summary of an arbitrary input value for the table. */
export function describeInput(value: unknown, max = 160): string {
  let text: string;
  if (typeof value === "string") {
    text = JSON.stringify(value);
  } else if (typeof value === "number") {
    text = Object.is(value, -0) ? "-0" : String(value);
  } else if (typeof value === "bigint") {
    text = `${value}n`;
  } else if (typeof value === "symbol") {
    text = value.toString();
  } else if (value === undefined) {
    text = "undefined";
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = `[unserialisable ${typeof value}]`;
    }
  }
  return text.length > max ? `${text.slice(0, max)}…(len ${text.length})` : text;
}

export class Reporter {
  readonly rows: ResultRow[] = [];
  private readonly startedAt = new Date();

  constructor(
    readonly campaign: string,
    readonly meta: Record<string, unknown> = {},
  ) {}

  add(row: Omit<ResultRow, "campaign">): void {
    this.rows.push({ campaign: this.campaign, ...row });
  }

  count(outcome: Outcome): number {
    return this.rows.filter((r) => r.outcome === outcome).length;
  }

  anomalies(): ResultRow[] {
    return this.rows.filter((r) => r.outcome.startsWith("ANOMALY"));
  }

  summary(): Record<string, unknown> {
    const byOutcome: Record<string, number> = {};
    const bySqlstate: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const row of this.rows) {
      byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
      byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
      if (row.sqlstate) bySqlstate[row.sqlstate] = (bySqlstate[row.sqlstate] ?? 0) + 1;
    }
    return {
      campaign: this.campaign,
      baseSeed: BASE_SEED,
      startedAt: this.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      executed: this.rows.length,
      byOutcome,
      bySqlstate,
      byKind,
      anomalySeeds: this.anomalies().map((r) => r.seed),
      ...this.meta,
    };
  }

  /** Writes `<STRESS_OUT>/<campaign>.json`; returns the path. */
  write(): string {
    const dir =
      process.env["STRESS_OUT"] ||
      join(PACKAGE_ROOT, "..", "..", "artifacts", "stress", "pkg-database-boundary-malformed");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.campaign}.json`);
    writeFileSync(path, JSON.stringify({ summary: this.summary(), rows: this.rows }, null, 1));
    return path;
  }
}

/** Assertion helper used by every campaign: anomalies fail loudly with seeds. */
export function formatAnomalies(reporter: Reporter): string {
  return reporter
    .anomalies()
    .slice(0, 20)
    .map(
      (r) =>
        `seed=${r.seed} idx=${r.index} kind=${r.kind} outcome=${r.outcome} sqlstate=${r.sqlstate ?? "-"} ` +
        `input=${r.input} msg=${r.message ?? "-"} note=${r.note ?? "-"}`,
    )
    .join("\n");
}

export const TEST_URL = process.env["DATABASE_URL_TEST"];

/** Pool pinned to an isolated schema so campaigns never touch `public`. */
export function schemaPool(schema: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString: TEST_URL,
    max: 4,
    options: `-c search_path=${schema}`,
  });
  return pool;
}

export function assertSafeIdent(ident: string): void {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(ident)) throw new Error(`unsafe identifier ${ident}`);
}
