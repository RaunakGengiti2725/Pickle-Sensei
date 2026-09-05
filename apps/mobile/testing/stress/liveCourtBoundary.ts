/**
 * Boundary / malformed-input generators for the Live Court module stress
 * suites (`__tests__/stress/liveCourt*.stress.test.ts`,
 * `__tests__/stress/liveSession*.stress.test.ts`).
 *
 * Everything is seeded (mulberry32 via `seededRandom`) so any iteration can be
 * replayed from its seed:
 *
 *   STRESS_ITER=<n>      iterations per campaign (default per suite, small)
 *   STRESS_SEED=<seed>   replay exactly one seed
 *   STRESS_RUN_ID=<id>   artifact directory name (default `local`)
 *
 * Results are written as JSON tables (seed → outcome) under
 * `artifacts/stress/<STRESS_RUN_ID>/` (repo-root relative, gitignored).
 */
import type {
  CheckpointKey,
  FaultDirection,
  ShotTypeSlug,
} from '@pickle/shared-types';
import { CHECKPOINTS, FAULT_DIRECTIONS } from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type {
  LiveSessionSnapshot,
  SessionEventView,
} from '../../src/flow/session';
import type { LiveCoachRecap } from '../../src/flow/liveSessionCoach';
import type { LiveSessionSummaryRecordV1 } from '../../src/flow/liveSessionSummary';
import { randomInt, seededRandom } from '../xcBehavioral/evidence';

// Node built-ins for the evidence sink. The mobile tsconfig excludes node
// typings, so the shims stay local (same convention as testing/xcBehavioral).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export type Rng = () => number;

export { randomInt, seededRandom };

export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick() over an empty list');
  return item;
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

// ─── Campaign control ──────────────────────────────────────────────────────

export function stressIterations(defaultCount: number): number {
  const raw = process.env['STRESS_ITER'];
  if (raw === undefined || raw === '') return defaultCount;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  }
  return parsed;
}

/** Deterministic seed list for a campaign: `STRESS_SEED` pins one seed,
 * otherwise `count` seeds derived from the campaign name so every run of the
 * same size replays the same inputs. */
export function campaignSeeds(campaign: string, count: number): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned)];
  let hash = 2166136261;
  for (const ch of campaign) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) seeds.push((hash + i * 7919) >>> 0);
  return seeds;
}

export function replayCommand(suiteFile: string, seed: number): string {
  return `cd apps/mobile && STRESS_SEED=${seed} npx jest --ci ${suiteFile}`;
}

// ─── Artifacts ─────────────────────────────────────────────────────────────

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

export function stressArtifactDir(): string {
  // apps/mobile/testing/stress → repo root
  return path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'artifacts',
    'stress',
    RUN_ID,
  );
}

export interface StressRow {
  seed: number;
  family: string;
  outcome: string;
  detail?: string;
  input?: string;
}

export interface StressTable {
  suite: string;
  campaign: string;
  runId: string;
  iterations: number;
  outcomes: Record<string, number>;
  heapUsedMbAtEnd: number;
  rows: StressRow[];
}

export function writeStressTable(
  suite: string,
  campaign: string,
  rows: StressRow[],
): StressTable {
  const outcomes: Record<string, number> = {};
  for (const row of rows)
    outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
  const table: StressTable = {
    suite,
    campaign,
    runId: RUN_ID,
    iterations: rows.length,
    outcomes,
    heapUsedMbAtEnd:
      Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
    rows,
  };
  const dir = stressArtifactDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${campaign}.json`),
    `${JSON.stringify(table, null, 2)}\n`,
  );
  return table;
}

/** Bounded preview of an arbitrary input for the JSON table. */
export function preview(value: unknown, max = 160): string {
  let text: string;
  try {
    text =
      typeof value === 'string'
        ? JSON.stringify(value)
        : (JSON.stringify(value, (_key, v: unknown) =>
            typeof v === 'number' && !Number.isFinite(v)
              ? `<${String(v)}>`
              : typeof v === 'bigint'
                ? `<bigint ${v.toString()}>`
                : typeof v === 'function'
                  ? '<function>'
                  : typeof v === 'symbol'
                    ? '<symbol>'
                    : v === undefined
                      ? '<undefined>'
                      : v,
          ) ?? String(value));
  } catch {
    text = `<unserializable ${typeof value}>`;
  }
  return text.length > max
    ? `${text.slice(0, max)}…(${text.length} chars)`
    : text;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.constructor.name}: ${error.message}`.slice(0, 200);
  }
  return `thrown non-Error: ${preview(error)}`;
}

// ─── Poison values ─────────────────────────────────────────────────────────

export const POISON_NUMBERS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  -1,
  0.5,
  10.05,
  1e21,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  -Number.MAX_SAFE_INTEGER,
  2 ** 31,
  -(2 ** 31),
  2 ** 32,
  101,
  100,
  11,
  -5.5,
];

const LONG_ASCII = 'A'.repeat(64 * 1024 + 1);
/** 64K+ code points that are each 2 bytes in UTF-8 (byte cap ≠ code-point cap). */
const LONG_TWO_BYTE = 'é'.repeat(64 * 1024 + 1);
/** 64K+ grapheme clusters, each many code points (family emoji with ZWJ). */
const LONG_GRAPHEMES = '👨‍👩‍👧‍👦'.repeat(16 * 1024 + 1);

export const POISON_STRINGS: readonly string[] = [
  '',
  ' ',
  '\0',
  'a\0b',
  '\u0000'.repeat(32),
  LONG_ASCII,
  LONG_TWO_BYTE,
  LONG_GRAPHEMES,
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '/etc/passwd',
  'file:///etc/passwd',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  'valueOf',
  '<script>alert(1)</script>',
  '\uFEFFbom',
  '\uD800', // lone high surrogate
  '\uDC00', // lone low surrogate
  '\u202Eevil', // RTL override
  'é', // NFC
  'e\u0301', // NFD of the same grapheme
  'ﬁ', // ligature (NFKC-differs)
  '{"a":1}',
  '[]',
  'null',
  'undefined',
  'NaN',
  '1e999',
  '-0',
  '9'.repeat(400),
  'live',
  'replay',
  'LIVE',
  'live\0',
  ' live',
];

export const PROTO_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

/** Any JSON-representable poison value plus a few non-JSON runtime ones
 * (only used when the input is an in-memory object, never a JSON text). */
export function poisonValue(rng: Rng, allowNonJson = false): unknown {
  const roll = rng();
  if (roll < 0.3) return pick(rng, POISON_NUMBERS);
  if (roll < 0.55) return pick(rng, POISON_STRINGS);
  if (roll < 0.62) return null;
  if (roll < 0.68) return chance(rng, 0.5);
  if (roll < 0.74) return [];
  if (roll < 0.8) return {};
  if (roll < 0.84) return [[[]]];
  if (roll < 0.88) return { polluted: 1 };
  if (roll < 0.92) return deepNested(rng, randomInt(rng, 50, 400));
  if (allowNonJson) {
    const nonJson = rng();
    if (nonJson < 0.25) return undefined;
    if (nonJson < 0.5) return () => 'fn';
    if (nonJson < 0.75) return Symbol('poison');
    return BigInt(Number.MAX_SAFE_INTEGER) * 4n;
  }
  return pick(rng, POISON_STRINGS);
}

export function deepNested(rng: Rng, depth: number): unknown {
  let value: unknown = chance(rng, 0.5) ? 1 : 'leaf';
  for (let i = 0; i < depth; i += 1) {
    value = chance(rng, 0.5) ? [value] : { k: value };
  }
  return value;
}

/** Build an object literal carrying a real prototype-pollution attempt:
 * JSON `{"__proto__": {...}}` becomes an own property after JSON.parse, but
 * an object-literal `__proto__` key sets the prototype — both are covered
 * by the JSON text path and the in-memory path respectively. */
export function pollutedObject(rng: Rng): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  const key = pick(rng, PROTO_KEYS);
  Object.defineProperty(target, key, {
    value: { polluted: 'yes' },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return target;
}

/** True when Object.prototype gained any enumerable key or the sentinel. */
export function objectPrototypePolluted(): boolean {
  const probe: Record<string, unknown> = {};
  return (
    Object.keys(Object.prototype).length > 0 ||
    probe['polluted'] !== undefined ||
    ({} as Record<string, unknown>)['polluted'] !== undefined ||
    Object.getOwnPropertyNames(Object.prototype).some(
      name => name === 'polluted' || name === 'yes',
    )
  );
}

// ─── JSON text malformation ────────────────────────────────────────────────

export type JsonMalformation =
  | 'truncate'
  | 'trailing_garbage'
  | 'byte_flip'
  | 'nan_literal'
  | 'infinity_literal'
  | 'single_quotes'
  | 'trailing_comma'
  | 'comment'
  | 'unquoted_key'
  | 'bom_prefix'
  | 'null_byte'
  | 'deep_nesting'
  | 'huge_number'
  | 'negative_zero'
  | 'duplicate_key'
  | 'proto_key'
  | 'array_root'
  | 'scalar_root'
  | 'empty'
  | 'whitespace'
  | 'lone_surrogate_escape'
  | 'invalid_escape';

export const JSON_MALFORMATIONS: readonly JsonMalformation[] = [
  'truncate',
  'trailing_garbage',
  'byte_flip',
  'nan_literal',
  'infinity_literal',
  'single_quotes',
  'trailing_comma',
  'comment',
  'unquoted_key',
  'bom_prefix',
  'null_byte',
  'deep_nesting',
  'huge_number',
  'negative_zero',
  'duplicate_key',
  'proto_key',
  'array_root',
  'scalar_root',
  'empty',
  'whitespace',
  'lone_surrogate_escape',
  'invalid_escape',
];

export function malformJsonText(
  rng: Rng,
  json: string,
  kind: JsonMalformation,
): string {
  switch (kind) {
    case 'truncate':
      return json.slice(0, randomInt(rng, 0, Math.max(0, json.length - 1)));
    case 'trailing_garbage':
      return `${json}${pick(rng, ['}', ']', 'x', ',', '{"a":1}', '\0', ' 1'])}`;
    case 'byte_flip': {
      const at = randomInt(rng, 0, Math.max(0, json.length - 1));
      const replacement = pick(rng, [
        '"',
        '{',
        '}',
        '[',
        ']',
        ':',
        ',',
        '\\',
        'x',
        '\0',
        '\n',
      ]);
      return `${json.slice(0, at)}${replacement}${json.slice(at + 1)}`;
    }
    case 'nan_literal':
      return json.replace(/"durationMs":\s*-?[\d.e+-]+/, '"durationMs":NaN');
    case 'infinity_literal':
      return json.replace(
        /"bestScore":\s*(-?[\d.e+-]+|null)/,
        '"bestScore":Infinity',
      );
    case 'single_quotes':
      return json.replace(/"/g, "'");
    case 'trailing_comma':
      return json.replace(/}$/, ',}');
    case 'comment':
      return `/* stored by an older build */ ${json}`;
    case 'unquoted_key':
      return json.replace(/"version"/, 'version');
    case 'bom_prefix':
      return `\uFEFF${json}`;
    case 'null_byte':
      return json.replace(/"live"/, '"live\\u0000"');
    case 'deep_nesting': {
      const depth = randomInt(rng, 1000, 200000);
      return `${'['.repeat(depth)}${']'.repeat(depth)}`;
    }
    case 'huge_number':
      return json.replace(
        /"strokeCount":\s*-?[\d.e+-]+/,
        `"strokeCount":${pick(rng, ['1e999', '-1e999', '1' + '0'.repeat(400), '9007199254740993', '1e21'])}`,
      );
    case 'negative_zero':
      return json.replace(/"scoredCount":\s*-?[\d.e+-]+/, '"scoredCount":-0');
    case 'duplicate_key':
      return json.replace(/^\{/, '{"version":2,"source":"nope",');
    case 'proto_key':
      return json.replace(
        /^\{/,
        `{"${pick(rng, PROTO_KEYS)}":{"polluted":"yes"},`,
      );
    case 'array_root':
      return `[${json}]`;
    case 'scalar_root':
      return pick(rng, ['1', '"live"', 'true', 'null', '-0', '1e400']);
    case 'empty':
      return '';
    case 'whitespace':
      return pick(rng, [' ', '\n', '\t\t', '\u00a0']);
    case 'lone_surrogate_escape':
      return json.replace(
        /"engineVersion":\s*"[^"]*"/,
        '"engineVersion":"\\ud800"',
      );
    case 'invalid_escape':
      return json.replace(
        /"engineVersion":\s*"[^"]*"/,
        '"engineVersion":"\\x41\\q"',
      );
  }
}

// ─── Live session summary records ──────────────────────────────────────────

export const SUMMARY_FIELDS: readonly (keyof LiveSessionSummaryRecordV1)[] = [
  'version',
  'engineVersion',
  'source',
  'durationMs',
  'strokeCount',
  'scoredCount',
  'noReadCount',
  'pendingCount',
  'startAverage',
  'endAverage',
  'delta',
  'bestScore',
  'sessionAverage',
  'cuesSpoken',
  'topCorrection',
  'correctionsByCheckpoint',
];

function score1(rng: Rng): number {
  return Math.round(rng() * 100) / 10;
}

/** A well-formed V1 record with realistic values. */
export function validSummaryRecord(rng: Rng): LiveSessionSummaryRecordV1 {
  const strokeCount = randomInt(rng, 0, 60);
  const scoredCount = randomInt(rng, 0, strokeCount);
  const noReadCount = randomInt(rng, 0, strokeCount - scoredCount);
  const pendingCount = strokeCount - scoredCount - noReadCount;
  const hasScores = scoredCount > 0;
  const startAverage = hasScores ? score1(rng) : null;
  const endAverage = hasScores ? score1(rng) : null;
  const corrections: Record<string, number> = {};
  const correctionCount = randomInt(rng, 0, 4);
  for (let i = 0; i < correctionCount; i += 1) {
    corrections[pick(rng, CHECKPOINTS)] = randomInt(rng, 1, 12);
  }
  const top = Object.entries(corrections).sort((a, b) => b[1] - a[1])[0];
  return {
    version: 1,
    engineVersion: pick(rng, ['session-engine-1', 'e2', 'v1.0.0']),
    source: chance(rng, 0.8) ? 'live' : 'replay',
    durationMs: randomInt(rng, 0, 3_600_000),
    strokeCount,
    scoredCount,
    noReadCount,
    pendingCount,
    startAverage,
    endAverage,
    delta:
      scoredCount >= 2 && startAverage !== null && endAverage !== null
        ? Math.round((endAverage - startAverage) * 10) / 10
        : null,
    bestScore: hasScores ? score1(rng) : null,
    sessionAverage: hasScores ? score1(rng) : null,
    cuesSpoken: randomInt(rng, 0, strokeCount + 2),
    topCorrection: top?.[0] ?? null,
    correctionsByCheckpoint: corrections,
  };
}

export type RecordMutation =
  | 'replace_field_poison'
  | 'delete_field'
  | 'future_version'
  | 'string_version'
  | 'bad_source'
  | 'unknown_key'
  | 'proto_key'
  | 'corrections_poison_values'
  | 'corrections_poison_keys'
  | 'corrections_not_object'
  | 'all_fields_poison'
  | 'nullify_numbers'
  | 'negative_counts'
  | 'fractional_counts'
  | 'out_of_range_scores'
  | 'engine_version_object';

export const RECORD_MUTATIONS: readonly RecordMutation[] = [
  'replace_field_poison',
  'delete_field',
  'future_version',
  'string_version',
  'bad_source',
  'unknown_key',
  'proto_key',
  'corrections_poison_values',
  'corrections_poison_keys',
  'corrections_not_object',
  'all_fields_poison',
  'nullify_numbers',
  'negative_counts',
  'fractional_counts',
  'out_of_range_scores',
  'engine_version_object',
];

/** Object shapes for `engineVersion` — `String(x)` on the first four throws
 * (no callable toString/valueOf), the rest coerce to junk text. */
export const ENGINE_VERSION_OBJECTS: readonly unknown[] = [
  { toString: 1 },
  { toString: null, valueOf: null },
  { toString: 'x', valueOf: {} },
  { toString: [] },
  {},
  { polluted: 1 },
  ['a', 'b'],
  [[1], { a: 1 }],
  [],
];

const COUNT_FIELDS = [
  'durationMs',
  'strokeCount',
  'scoredCount',
  'noReadCount',
  'pendingCount',
  'cuesSpoken',
] as const;
const SCORE_FIELDS = [
  'startAverage',
  'endAverage',
  'delta',
  'bestScore',
  'sessionAverage',
] as const;

/** Apply one named mutation to an in-memory copy of a record. Non-JSON
 * poison (functions, symbols, undefined, bigint) is never used here because
 * the record is serialized to JSON text before parsing. */
export function mutateRecord(
  rng: Rng,
  record: LiveSessionSummaryRecordV1,
  mutation: RecordMutation,
): Record<string, unknown> {
  const target: Record<string, unknown> = { ...record };
  switch (mutation) {
    case 'replace_field_poison':
      target[pick(rng, SUMMARY_FIELDS)] = poisonValue(rng);
      return target;
    case 'delete_field':
      delete target[pick(rng, SUMMARY_FIELDS)];
      return target;
    case 'future_version':
      target['version'] = pick(rng, [2, 3, 1.5, 0, -1, 1e21, 99999999999]);
      return target;
    case 'string_version':
      target['version'] = pick(rng, ['1', '1.0', 'v1', '01', ' 1']);
      return target;
    case 'bad_source':
      target['source'] = pick(rng, POISON_STRINGS);
      return target;
    case 'unknown_key':
      target[pick(rng, POISON_STRINGS).slice(0, 64) || 'k'] = poisonValue(rng);
      return target;
    case 'proto_key':
      target[pick(rng, PROTO_KEYS)] = { polluted: 'yes' };
      return target;
    case 'corrections_poison_values': {
      const corrections: Record<string, unknown> = {};
      for (const key of CHECKPOINTS.slice(0, randomInt(rng, 1, 5))) {
        corrections[key] = poisonValue(rng);
      }
      target['correctionsByCheckpoint'] = corrections;
      return target;
    }
    case 'corrections_poison_keys': {
      const corrections: Record<string, unknown> = {};
      for (let i = 0; i < randomInt(rng, 1, 4); i += 1) {
        corrections[pick(rng, [...POISON_STRINGS, ...PROTO_KEYS])] = randomInt(
          rng,
          1,
          5,
        );
      }
      target['correctionsByCheckpoint'] = corrections;
      return target;
    }
    case 'corrections_not_object':
      target['correctionsByCheckpoint'] = pick(rng, [
        [],
        [1, 2],
        'athletic_base',
        3,
        null,
        true,
        [['athletic_base', 2]],
      ]);
      return target;
    case 'all_fields_poison':
      for (const field of SUMMARY_FIELDS) target[field] = poisonValue(rng);
      return target;
    case 'nullify_numbers':
      for (const field of [...COUNT_FIELDS, ...SCORE_FIELDS])
        target[field] = null;
      return target;
    case 'negative_counts':
      for (const field of COUNT_FIELDS) {
        if (chance(rng, 0.6)) target[field] = -randomInt(rng, 1, 1000);
      }
      return target;
    case 'fractional_counts':
      for (const field of COUNT_FIELDS) {
        if (chance(rng, 0.6)) target[field] = randomInt(rng, 0, 1000) + rng();
      }
      return target;
    case 'out_of_range_scores':
      for (const field of SCORE_FIELDS) {
        if (chance(rng, 0.6)) {
          target[field] = pick(rng, [-1, 10.1, 11, 100, 1e308, -1e308, -0]);
        }
      }
      return target;
    case 'engine_version_object':
      target['engineVersion'] = pick(rng, ENGINE_VERSION_OBJECTS);
      return target;
  }
}

/** True when `String(value)` throws — a non-null object whose own
 * `toString` is not callable and whose `valueOf` (own or inherited
 * Object.prototype.valueOf, which returns the object itself) yields no
 * primitive. Evaluated directly so the predicate matches the engine. */
export function stringCoercionThrows(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  try {
    String(value);
    return false;
  } catch {
    return true;
  }
}

// ─── Well-formedness of a parsed V1 record ─────────────────────────────────

const SOURCES = new Set(['live', 'replay']);

/** Returns the list of contract violations in a parsed record (empty = well
 * formed). Only the parser's OWN documented contract is checked here —
 * range/semantic acceptance is recorded separately as soft observations. */
export function recordViolations(record: LiveSessionSummaryRecordV1): string[] {
  const out: string[] = [];
  if (record.version !== 1) out.push('version!=1');
  if (typeof record.engineVersion !== 'string')
    out.push('engineVersion not string');
  if (!SOURCES.has(record.source)) out.push('source not live|replay');
  for (const field of COUNT_FIELDS) {
    const value = record[field];
    if (!Number.isSafeInteger(value) || value < 0)
      out.push(`${field} not count`);
  }
  for (const field of SCORE_FIELDS) {
    const value = record[field];
    if (
      value !== null &&
      !(typeof value === 'number' && Number.isFinite(value))
    ) {
      out.push(`${field} not finite|null`);
    }
  }
  if (
    record.topCorrection !== null &&
    typeof record.topCorrection !== 'string'
  ) {
    out.push('topCorrection not string|null');
  }
  if (
    typeof record.correctionsByCheckpoint !== 'object' ||
    record.correctionsByCheckpoint === null ||
    Array.isArray(record.correctionsByCheckpoint)
  ) {
    out.push('correctionsByCheckpoint not object');
  } else {
    if (
      Object.getPrototypeOf(record.correctionsByCheckpoint) !== Object.prototype
    ) {
      out.push('correctionsByCheckpoint prototype tampered');
    }
    for (const [key, value] of Object.entries(record.correctionsByCheckpoint)) {
      if (!Number.isSafeInteger(value)) out.push(`corrections[${key}] not int`);
    }
  }
  if (Object.getPrototypeOf(record) !== Object.prototype)
    out.push('record prototype tampered');
  return out;
}

/** Soft observations: values the parser ACCEPTED that are outside the
 * product's semantic ranges. Not contract violations — reported as
 * boundary findings with counts. */
export function recordSoftObservations(
  record: LiveSessionSummaryRecordV1,
): string[] {
  const out: string[] = [];
  for (const field of SCORE_FIELDS) {
    const value = record[field];
    if (value === null) continue;
    if (Object.is(value, -0)) out.push(`${field}=-0`);
    else if (
      field === 'delta' ? Math.abs(value) > 10 : value < 0 || value > 10
    ) {
      out.push(`${field} out of 0..10`);
    }
  }
  for (const field of COUNT_FIELDS) {
    if (Object.is(record[field], -0)) out.push(`${field}=-0`);
  }
  if (record.engineVersion.length > 256) out.push('engineVersion > 256 chars');
  if (record.engineVersion.includes('\0')) out.push('engineVersion has NUL');
  if (record.engineVersion === '[object Object]')
    out.push('engineVersion coerced object');
  if (record.topCorrection !== null) {
    if (!(CHECKPOINTS as readonly string[]).includes(record.topCorrection)) {
      out.push('topCorrection not a CheckpointKey');
    }
    if (record.topCorrection.length > 256)
      out.push('topCorrection > 256 chars');
  }
  for (const [key, value] of Object.entries(record.correctionsByCheckpoint)) {
    if (!(CHECKPOINTS as readonly string[]).includes(key)) {
      out.push('corrections key not a CheckpointKey');
      break;
    }
    if (value < 0) {
      out.push('corrections value negative');
      break;
    }
  }
  return out;
}

// ─── Session events / snapshots for the coach ──────────────────────────────

export interface CheckpointSpec {
  key: CheckpointKey;
  score: number | null;
  direction: FaultDirection;
  severity: number;
  applicable?: boolean;
}

export function analysisRecord(
  overallScore: number | null,
  resultKind: 'scored' | 'low_confidence',
  checkpoints: readonly CheckpointSpec[],
  shotType: ShotTypeSlug = 'forehand_drive',
): AnalysisRecord {
  return {
    strokeResolution:
      resultKind === 'scored'
        ? { kind: 'declared', shotType }
        : { kind: 'unresolved' },
    result: {
      resultKind,
      overallScore,
      checkpoints: checkpoints.map(spec => ({
        key: spec.key,
        score: spec.score,
        confidence: 0.9,
        band: 'yellow',
        direction: spec.direction,
        severity: spec.severity,
        applicable: spec.applicable ?? true,
      })),
    },
  } as unknown as AnalysisRecord;
}

export function validCheckpoints(rng: Rng): CheckpointSpec[] {
  const count = randomInt(rng, 0, 6);
  const keys = [...CHECKPOINTS];
  const out: CheckpointSpec[] = [];
  for (let i = 0; i < count && keys.length > 0; i += 1) {
    const at = randomInt(rng, 0, keys.length - 1);
    const key = keys.splice(at, 1)[0];
    if (key === undefined) break;
    const score = chance(rng, 0.15) ? null : randomInt(rng, 0, 100);
    out.push({
      key,
      score,
      direction: pick(rng, FAULT_DIRECTIONS),
      severity: Math.round(rng() * 100) / 100,
      applicable: chance(rng, 0.85),
    });
  }
  return out;
}

/** A type-valid event at `index` in a random terminal or non-terminal state. */
export function validEvent(rng: Rng, index: number): SessionEventView {
  const roll = rng();
  let state: SessionEventView['state'];
  let analysis: AnalysisRecord | null = null;
  if (roll < 0.15) state = 'pending';
  else if (roll < 0.25) state = 'processing';
  else if (roll < 0.35) state = 'abstained';
  else {
    state = 'ready';
    const kind = rng();
    if (kind < 0.7) {
      analysis = analysisRecord(score1(rng), 'scored', validCheckpoints(rng));
    } else if (kind < 0.9) {
      analysis = analysisRecord(null, 'low_confidence', []);
    } else {
      // analysis ran but produced no result payload — honest no-read.
      // (`ready` with `analysis: null` is out of contract: SessionEventAnalysisOutcome
      // always carries a real AnalysisRecord on `ready`.)
      analysis = {
        ...analysisRecord(null, 'low_confidence', []),
        result: null,
      };
    }
  }
  const startMs = index * 1000 + randomInt(rng, 0, 400);
  const durationMs = randomInt(rng, 120, 900);
  return {
    eventId: `E${index + 1}`,
    index,
    startMs,
    endMs: startMs + durationMs,
    peakMs: startMs + Math.floor(durationMs / 2),
    durationMs,
    peakSpeed: Math.round(rng() * 600) / 100,
    paddleConfirmed: chance(rng, 0.8),
    closeReason: pick(rng, ['settle', 'next_stroke_valley', 'safety_max']),
    closedAtMs: startMs + durationMs + 200,
    state,
    pendingReason: state === 'pending' ? 'queued' : null,
    abstainReason: state === 'abstained' ? 'no_player' : null,
    analysis,
    family: null,
    boundaryUncertain: chance(rng, 0.1),
    retroSuppressed: chance(rng, 0.05),
  };
}

export function validSnapshot(
  rng: Rng,
  events: SessionEventView[],
  overrides: Partial<LiveSessionSnapshot> = {},
): LiveSessionSnapshot {
  const last = events[events.length - 1];
  return {
    sessionId: overrides.sessionId ?? `session-${Math.floor(rng() * 1e9)}`,
    phase: 'running',
    source: chance(rng, 0.85) ? 'live' : 'replay',
    startedAtIso: '2026-09-05T00:00:00.000Z',
    durationMs: last ? last.closedAtMs + randomInt(rng, 0, 500) : 0,
    strokeCount: events.length,
    events,
    distribution: [],
    qualityNotes: [],
    droppedLateSamples: 0,
    onUpdateFailures: 0,
    engineVersion: 'stress-engine-1',
    analysisProviderId: 'stress-provider',
    ...overrides,
  };
}

export type EventMalformation =
  | 'analysis_undefined'
  | 'result_undefined'
  | 'result_no_checkpoints'
  | 'checkpoints_not_array'
  | 'checkpoint_entry_poison'
  | 'checkpoint_key_poison'
  | 'checkpoint_key_proto'
  | 'checkpoint_direction_proto'
  | 'overall_score_poison'
  | 'scored_null_score'
  | 'low_confidence_with_score'
  | 'result_kind_poison'
  | 'state_poison'
  | 'event_id_poison'
  | 'event_id_proto'
  | 'index_poison'
  | 'end_ms_poison'
  | 'event_not_object';

export const EVENT_MALFORMATIONS: readonly EventMalformation[] = [
  'analysis_undefined',
  'result_undefined',
  'result_no_checkpoints',
  'checkpoints_not_array',
  'checkpoint_entry_poison',
  'checkpoint_key_poison',
  'checkpoint_key_proto',
  'checkpoint_direction_proto',
  'overall_score_poison',
  'scored_null_score',
  'low_confidence_with_score',
  'result_kind_poison',
  'state_poison',
  'event_id_poison',
  'event_id_proto',
  'index_poison',
  'end_ms_poison',
  'event_not_object',
];

type LooseRecord = Record<string, unknown>;

function readyScored(rng: Rng, index: number): SessionEventView {
  const event = validEvent(rng, index);
  return {
    ...event,
    state: 'ready',
    analysis: analysisRecord(score1(rng), 'scored', [
      {
        key: pick(rng, CHECKPOINTS),
        score: randomInt(rng, 0, 100),
        direction: pick(rng, FAULT_DIRECTIONS),
        severity: 0.6,
      },
      ...validCheckpoints(rng),
    ]),
  };
}

/** Produce an OUT-OF-CONTRACT event (cast to the view type) so the coach's
 * behaviour on corrupt upstream records can be observed and tabulated. */
export function malformEvent(
  rng: Rng,
  index: number,
  kind: EventMalformation,
): SessionEventView {
  const base = readyScored(rng, index);
  const loose = { ...base } as LooseRecord;
  const analysis = { ...(base.analysis as unknown as LooseRecord) };
  const result = { ...(analysis['result'] as LooseRecord) };
  const checkpoints = [...(result['checkpoints'] as LooseRecord[])];
  const attach = (): SessionEventView => {
    analysis['result'] = result;
    loose['analysis'] = analysis;
    return loose as unknown as SessionEventView;
  };
  switch (kind) {
    case 'analysis_undefined':
      delete loose['analysis'];
      return loose as unknown as SessionEventView;
    case 'result_undefined':
      delete analysis['result'];
      loose['analysis'] = analysis;
      return loose as unknown as SessionEventView;
    case 'result_no_checkpoints':
      delete result['checkpoints'];
      if (chance(rng, 0.5)) result['resultKind'] = 'low_confidence';
      return attach();
    case 'checkpoints_not_array':
      result['checkpoints'] = pick(rng, [null, {}, 'athletic_base', 3, true]);
      return attach();
    case 'checkpoint_entry_poison':
      checkpoints.splice(
        randomInt(rng, 0, checkpoints.length),
        0,
        poisonValue(rng, true) as LooseRecord,
      );
      result['checkpoints'] = checkpoints;
      return attach();
    case 'checkpoint_key_poison': {
      const target = checkpoints[0];
      if (target) target['key'] = poisonValue(rng, true);
      result['checkpoints'] = checkpoints;
      return attach();
    }
    case 'checkpoint_key_proto': {
      const target = checkpoints[0];
      if (target) {
        target['key'] = pick(rng, PROTO_KEYS);
        target['severity'] = 0.9;
        target['applicable'] = true;
      }
      result['checkpoints'] = checkpoints;
      return attach();
    }
    case 'checkpoint_direction_proto': {
      const target = checkpoints[0];
      if (target) {
        target['key'] = pick(rng, [...PROTO_KEYS, 'toString', 'valueOf']);
        target['direction'] = pick(rng, [
          'constructor',
          'name',
          'toString',
          'hasOwnProperty',
          'length',
          '__proto__',
        ]);
        target['severity'] = 0.9;
        target['applicable'] = true;
      }
      result['checkpoints'] = checkpoints;
      return attach();
    }
    case 'overall_score_poison':
      result['overallScore'] = pick(rng, POISON_NUMBERS);
      return attach();
    case 'scored_null_score':
      result['overallScore'] = null;
      return attach();
    case 'low_confidence_with_score':
      result['resultKind'] = 'low_confidence';
      result['overallScore'] = score1(rng);
      return attach();
    case 'result_kind_poison':
      result['resultKind'] = poisonValue(rng, true);
      return attach();
    case 'state_poison':
      loose['state'] = poisonValue(rng, true);
      return attach();
    case 'event_id_poison':
      loose['eventId'] = poisonValue(rng, true);
      return attach();
    case 'event_id_proto':
      loose['eventId'] = pick(rng, PROTO_KEYS);
      return attach();
    case 'index_poison':
      loose['index'] = pick(rng, POISON_NUMBERS);
      return attach();
    case 'end_ms_poison':
      loose['endMs'] = pick(rng, POISON_NUMBERS);
      loose['durationMs'] = pick(rng, POISON_NUMBERS);
      return attach();
    case 'event_not_object':
      return poisonValue(rng, true) as SessionEventView;
  }
}

// ─── Coach recap fixtures (for summary round-trips) ────────────────────────

export function validRecap(rng: Rng): LiveCoachRecap {
  const corrections: Partial<Record<CheckpointKey, number>> = {};
  for (let i = 0; i < randomInt(rng, 0, 4); i += 1) {
    corrections[pick(rng, CHECKPOINTS)] = randomInt(rng, 1, 9);
  }
  let top: CheckpointKey | null = null;
  let topCount = 0;
  for (const [key, count] of Object.entries(corrections) as Array<
    [CheckpointKey, number]
  >) {
    if (count > topCount) {
      top = key;
      topCount = count;
    }
  }
  const cueCount = randomInt(rng, 0, 30);
  const spokenCount = randomInt(rng, 0, cueCount);
  return {
    cues: Array.from({ length: cueCount }, (_unused, i) => ({
      eventId: `E${i + 1}`,
      category: 'PRAISE',
      text: 'Great rep. Repeat that.',
      targetCheckpoint: null,
      atMs: i * 1000,
      spoken: i < spokenCount,
    })),
    spokenCount,
    correctionsByCheckpoint: corrections,
    topCorrection: top,
  };
}
