/**
 * Boundary / malformed-input stress toolkit shared by the `__tests__/stress`
 * suites: a seeded PRNG, hostile value pools, and the seed → outcome JSON
 * table.
 *
 *   STRESS_ITER=<n>      iterations per scenario (default 40 — suite-speed)
 *   STRESS_SEED=<seed>   replay exactly one seed in every scenario
 *   STRESS_RUN_ID=<id>   write apps/mobile/artifacts/stress/<id>/<suite>.json
 *
 * Every iteration is fully determined by (scenario, seed): the generator draws
 * only from the seeded PRNG, so any row in the table replays with
 * `STRESS_SEED=<seed> npx jest <suite>`.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const STRESS_ITER = (() => {
  const raw = process.env['STRESS_ITER'];
  const n = raw ? Number(raw) : 40;
  return Number.isSafeInteger(n) && n > 0 ? n : 40;
})();

export const STRESS_SEED = (() => {
  const raw = process.env['STRESS_SEED'];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
})();

/** Deterministic per-scenario seed list: fnv1a(scenario) % 100k + i * 7919. */
export function stressSeeds(scenario: string): number[] {
  if (STRESS_SEED !== null) return [STRESS_SEED];
  let h = 2166136261;
  for (const ch of scenario) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const base = (h % 100_000) + 1;
  return Array.from({ length: STRESS_ITER }, (_, i) => base + i * 7919);
}

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number) =>
    maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    pick: items => items[int(items.length)]!,
    chance: p => next() < p,
    shuffle: items => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = int(i + 1);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    },
  };
}

// ─── Hostile value pools ───────────────────────────────────────────────────

/** Own-property names every plain `Record<string, string>` inherits. */
export const PROTOTYPE_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__lookupGetter__',
];

/** Finite and non-finite numbers at the edges of IEEE-754 doubles. */
export const HOSTILE_NUMBERS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  100,
  -50,
  250,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  2 ** 53,
  -(2 ** 53),
  0.1 + 0.2,
  1e21,
  1e-7,
];

export const ZERO_WIDTH = '\u200b';
export const NULL_BYTE = '\u0000';
/** "é" as one code point vs "e" + combining acute — equal under NFC. */
export const NFC_E_ACUTE = '\u00e9';
export const NFD_E_ACUTE = 'e\u0301';
/** Family emoji: 7 code points, 11 UTF-16 units, 1 grapheme. */
export const ZWJ_FAMILY =
  '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';

export function hugeString(rng: Rng, minBytes = 64 * 1024): string {
  const unit = rng.pick(['a', 'é', 'ü', ZWJ_FAMILY, NULL_BYTE, '_', ' ']);
  const repeat =
    Math.ceil(minBytes / Math.max(1, Buffer.byteLength(unit))) + rng.int(2048);
  return unit.repeat(repeat);
}

export const PATH_TRAVERSAL: readonly string[] = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '/dev/null',
  'file:///etc/shadow',
  '..%c0%af..%c0%af',
  '\u2025/\u2025/',
];

export const INJECTION_STRINGS: readonly string[] = [
  "' OR 1=1 --",
  '"; DROP TABLE local_shot; --',
  '<script>alert(1)</script>',
  '{{7*7}}',
  '${jndi:ldap://x}',
  '%s%s%s%n',
  '\r\n\r\nHTTP/1.1 200 OK',
];

/** Strings a corrupt local row could plausibly carry into the focus engine. */
export function hostileString(rng: Rng): string {
  const roll = rng.next();
  if (roll < 0.15) return rng.pick(PROTOTYPE_KEYS);
  if (roll < 0.25) return rng.pick(PATH_TRAVERSAL);
  if (roll < 0.35) return rng.pick(INJECTION_STRINGS);
  if (roll < 0.4) return hugeString(rng);
  if (roll < 0.5) return rng.pick(['', ' ', '\t', '\n', NULL_BYTE, ZERO_WIDTH]);
  if (roll < 0.6)
    return rng.pick([NFC_E_ACUTE, NFD_E_ACUTE, ZWJ_FAMILY, '\ufeff', '\ud800']);
  if (roll < 0.7)
    return rng.pick(['undefined', 'null', 'NaN', '[object Object]', 'true']);
  if (roll < 0.8) return `dink${NULL_BYTE}${rng.int(1e6)}`;
  if (roll < 0.9) return String(rng.pick(HOSTILE_NUMBERS));
  return `${rng.pick(['dink', 'serve', 'volley'])}${ZERO_WIDTH.repeat(rng.int(3))}`;
}

/** Any JSON-representable value of the wrong shape. */
export function hostileJsonValue(rng: Rng, depth = 0): unknown {
  const roll = rng.next();
  if (roll < 0.15) return null;
  if (roll < 0.3) return rng.pick(HOSTILE_NUMBERS.filter(Number.isFinite));
  if (roll < 0.45) return hostileString(rng);
  if (roll < 0.55) return rng.chance(0.5);
  if (roll < 0.7) return {};
  if (roll < 0.8) return [];
  if (depth > 2) return 'leaf';
  if (roll < 0.9) {
    return Array.from({ length: rng.int(3) }, () =>
      hostileJsonValue(rng, depth + 1),
    );
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < rng.int(3); i += 1) {
    // JSON.parse makes "__proto__" an OWN key; plain assignment would swap
    // the prototype instead, which no JSON payload can do.
    Object.defineProperty(obj, hostileString(rng).slice(0, 32), {
      value: hostileJsonValue(rng, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return obj;
}

/** Values JSON cannot carry but a caller in memory could still pass. */
export function hostileRuntimeValue(rng: Rng): unknown {
  const roll = rng.next();
  if (roll < 0.5) return hostileJsonValue(rng);
  if (roll < 0.6) return undefined;
  if (roll < 0.7) return rng.pick(HOSTILE_NUMBERS);
  if (roll < 0.8) return Symbol('hostile');
  if (roll < 0.85) return () => 'fn';
  if (roll < 0.9) return Object.create(null);
  if (roll < 0.95) return new Date(NaN);
  return BigInt(rng.int(1e6));
}

// ─── Deep freeze + describe (purity oracle and compact evidence) ───────────

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return value;
}

/** Short, JSON-safe description of an arbitrary value (huge strings → length). */
export function describeValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 48
      ? `<string len=${value.length} bytes=${Buffer.byteLength(value)} head=${JSON.stringify(
          value.slice(0, 12),
        )}>`
      : JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Object.is(value, -0)
      ? '-0'
      : Number.isFinite(value)
        ? value
        : String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return '<function>';
  if (value === undefined) return '<undefined>';
  if (value === null) return null;
  if (value instanceof Date) return `<Date ${value.toString()}>`;
  if (Array.isArray(value)) {
    if (depth > 3) return `<array len=${value.length}>`;
    return value.slice(0, 12).map(item => describeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 3) return '<object>';
    const proto = Object.getPrototypeOf(value);
    const out: Record<string, unknown> =
      proto === null ? { '<proto>': 'null' } : {};
    for (const key of Object.keys(value).slice(0, 12)) {
      out[key.length > 32 ? `<key len=${key.length}>` : key] = describeValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
    }
    return out;
  }
  return String(value);
}

// ─── Violations + JSON outcome table ───────────────────────────────────────

export class Violations {
  readonly list: string[] = [];
  check(condition: boolean, message: string): void {
    if (!condition) this.list.push(message);
  }
}

export interface StressOutcomeRow {
  suite: string;
  scenario: string;
  seed: number;
  status: 'HELD' | 'BROKEN';
  wallMs: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  violations: string[];
}

const rows: StressOutcomeRow[] = [];
const RUN_ID = process.env['STRESS_RUN_ID'] ?? null;

export function recordStressRow(row: StressOutcomeRow): void {
  rows.push(row);
}

export function stressRows(suite: string): readonly StressOutcomeRow[] {
  return rows.filter(row => row.suite === suite);
}

export function flushStressTable(suite: string): string | null {
  if (!RUN_ID) return null;
  const dir = join(__dirname, '..', '..', 'artifacts', 'stress', RUN_ID);
  mkdirSync(dir, { recursive: true });
  const mine = stressRows(suite);
  const byScenario: Record<
    string,
    { executed: number; held: number; broken: number }
  > = {};
  for (const row of mine) {
    const bucket = (byScenario[row.scenario] ??= {
      executed: 0,
      held: 0,
      broken: 0,
    });
    bucket.executed += 1;
    if (row.status === 'HELD') bucket.held += 1;
    else bucket.broken += 1;
  }
  const summary = {
    suite,
    runId: RUN_ID,
    iterationsPerScenario: STRESS_ITER,
    executed: mine.length,
    held: mine.filter(r => r.status === 'HELD').length,
    broken: mine.filter(r => r.status === 'BROKEN').length,
    byScenario,
    brokenSeeds: mine
      .filter(r => r.status === 'BROKEN')
      .map(r => ({
        scenario: r.scenario,
        seed: r.seed,
        violations: r.violations,
      })),
    rows: mine,
  };
  const file = join(dir, `${suite}.json`);
  writeFileSync(file, JSON.stringify(summary, null, 2));
  return file;
}
