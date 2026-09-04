/**
 * Boundary / malformed-input fuzzing support for the billing module
 * (`src/billing/*` + `src/state/accessStore.ts`).
 *
 * Everything here is deterministic: a `Rng` seeded from the iteration seed
 * drives every choice, so any row of the emitted JSON table replays with
 *   STRESS_ONLY=<seed> npx jest __tests__/stress/<suite>
 *
 * Scale knobs (read by the suites through `stressConfig()`):
 *   STRESS_ITER=<n>   iterations per suite (default 120 — fast enough for CI)
 *   STRESS_SEED=<n>   base seed (default 20260904)
 *   STRESS_ONLY=<n>   replay exactly one seed
 *   STRESS_OUT=<dir>  where the seed → outcome tables go (default artifacts/stress)
 */
import { BillingError, type CanonicalAccessState } from '../../src/billing';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see __tests__/matrix/networkAuthMatrix.test.ts), shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join, resolve } = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

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
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = copy[i]!;
      copy[i] = copy[j]!;
      copy[j] = a;
    }
    return copy;
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

export interface StressConfig {
  iterations: number;
  baseSeed: number;
  only: number | null;
  outDir: string;
}

export function stressConfig(defaultIterations = 120): StressConfig {
  const iterations = Number(process.env.STRESS_ITER ?? defaultIterations);
  const baseSeed = Number(process.env.STRESS_SEED ?? 20260904);
  const only = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(
      `STRESS_ITER must be a positive integer, got ${iterations}`,
    );
  }
  if (!Number.isInteger(baseSeed)) {
    throw new Error(`STRESS_SEED must be an integer, got ${baseSeed}`);
  }
  if (only !== null && !Number.isInteger(only)) {
    throw new Error(`STRESS_ONLY must be an integer seed, got ${only}`);
  }
  const outDir =
    process.env.STRESS_OUT ??
    resolve(__dirname, '..', '..', 'artifacts', 'stress');
  return { iterations, baseSeed, only, outDir };
}

export function seedsFor(config: StressConfig): number[] {
  if (config.only !== null) return [config.only];
  const seeds: number[] = [];
  for (let i = 0; i < config.iterations; i++) seeds.push(config.baseSeed + i);
  return seeds;
}

// ─── Value pools ─────────────────────────────────────────────────────────────

export const HUGE_STRING = 'x'.repeat(65_537);
export const HUGE_UNICODE = '\u{1F4A9}'.repeat(20_000); // 80 KB, 20k code points
export const HUGE_GRAPHEMES = 'e\u0301'.repeat(33_000); // 66k code points, 33k graphemes

export const WEIRD_STRINGS: readonly string[] = [
  '',
  ' ',
  '\t\n ',
  '\u0000',
  'a\u0000b',
  '\uFEFF',
  '\u200b',
  '\u00a0',
  HUGE_STRING,
  HUGE_UNICODE,
  HUGE_GRAPHEMES,
  'é',
  'e\u0301',
  '\ufb01',
  '\uff21',
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2f',
  '/v1/me/access/../../admin',
  'javascript:alert(1)',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '{"a":1}',
  '[]',
  'null',
  'undefined',
  'NaN',
  '-0',
  '1e309',
  'true',
  '\r\nX-Injected: 1',
  '<script>alert(1)</script>',
  '\ud800',
  '\udfff',
  '\uffff',
  'premium',
  'PREMIUM',
  'Premium',
  'prem\u0131um',
  'premium\u200b',
  'pre\u00admium',
  '\uff50remium',
  ' premium',
  'premium ',
  'pickle_sensei_pro',
  'pickle_sensei_pro_monthly',
  '$rc_annual',
  'ANNUAL',
  'annual',
  'P7D',
  'p7d',
  'P0D',
  'P-1D',
  'PT7D',
  'P99999999999999999999D',
  '2027-08-27T00:00:00.000Z',
  '2027-08-27',
  '1',
  '0000-00-00',
  '9999-12-31T23:59:59.999Z',
  '+275760-09-13T00:00:00.001Z',
  'appl_public',
  'sk_secret',
  'SK_SECRET',
  ' sk_secret ',
  '\uFEFFsk_secret',
  'test_store',
  '11111111-1111-4111-8111-111111111111',
  '11111111-1111-4111-8111-11111111111',
  '11111111-1111-4111-8111-1111111111111',
  '11111111-1111-0111-8111-111111111111',
  '11111111-1111-4111-0111-111111111111',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '{11111111-1111-4111-8111-111111111111}',
  'urn:uuid:11111111-1111-4111-8111-111111111111',
  '11111111111141118111111111111111',
  '11111111-1111-4111-8111-111111111111\u200d',
  '\uff11\uff11\uff11\uff11\uff11\uff11\uff11\uff11-1111-4111-8111-111111111111',
  'apple:001234.abcdef',
  'google-oauth2|123456789',
];

export const WEIRD_NUMBERS: readonly number[] = [
  0,
  -0,
  1,
  2,
  3,
  -1,
  2.5,
  1.0000000000000002,
  0.1 + 0.2,
  NaN,
  Infinity,
  -Infinity,
  2 ** 53,
  2 ** 53 - 1,
  -(2 ** 53),
  1e308,
  -1e308,
  5e-324,
  4294967296,
  2147483648,
  -2147483649,
  1e21,
  999,
  401,
  200,
];

/** A scalar that a JSON body or a native SDK bridge could plausibly hand
 * over: strings, numbers, booleans, null/undefined. */
export function weirdScalar(rng: Rng): unknown {
  switch (rng.int(0, 5)) {
    case 0:
    case 1:
      return rng.pick(WEIRD_STRINGS);
    case 2:
    case 3:
      return rng.pick(WEIRD_NUMBERS);
    case 4:
      return rng.pick([true, false] as const);
    default:
      return rng.pick([null, undefined] as const);
  }
}

/** Own-property "__proto__" / "constructor" keys, exactly as JSON.parse
 * produces them from a hostile body. */
export function pollutionObject(rng: Rng): unknown {
  return rng.pick([
    () => JSON.parse('{"__proto__":{"polluted":"yes"}}') as unknown,
    () =>
      JSON.parse('{"constructor":{"prototype":{"polluted":"yes"}}}') as unknown,
    () => JSON.parse('{"__proto__":null}') as unknown,
    () => Object.create(null) as unknown,
    () => {
      const o = Object.create(null) as Record<string, unknown>;
      o['premium'] = true;
      return o;
    },
    () => JSON.parse('[{"__proto__":{"polluted":"yes"}}]') as unknown,
  ])();
}

export function weirdValue(rng: Rng, depth = 0): unknown {
  const roll = rng.int(0, 11);
  if (depth > 2 || roll < 6) return weirdScalar(rng);
  switch (roll) {
    case 6:
      return [];
    case 7:
      return {};
    case 8:
      return pollutionObject(rng);
    case 9: {
      const length = rng.pick([1, 2, 3, 50, 1000, 20_000]);
      const array: unknown[] = [];
      for (let i = 0; i < length; i++) {
        array.push(
          length > 10 ? rng.pick(WEIRD_STRINGS) : weirdValue(rng, depth + 1),
        );
      }
      return array;
    }
    case 10: {
      const record: Record<string, unknown> = {};
      const keys = rng.int(1, 4);
      for (let i = 0; i < keys; i++) {
        record[rng.pick(WEIRD_STRINGS)] = weirdValue(rng, depth + 1);
      }
      return record;
    }
    default: {
      // Deep nesting.
      let value: unknown = weirdScalar(rng);
      const levels = rng.pick([3, 10, 100, 5000]);
      for (let i = 0; i < levels; i++)
        value = rng.chance(0.5) ? [value] : { v: value };
      return value;
    }
  }
}

// ─── Structural mutation ─────────────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out as T;
  }
  return value;
}

interface Path {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
}

// Earlier mutations may have planted 5000-deep or 20k-wide values; never
// walk into those (the walk is for choosing the NEXT target, not for fidelity).
const MAX_WALK_DEPTH = 8;
const MAX_WALK_WIDTH = 32;

function collectPaths(value: unknown, out: Path[], depth = 0): void {
  if (depth > MAX_WALK_DEPTH) return;
  if (Array.isArray(value)) {
    if (value.length > MAX_WALK_WIDTH) return;
    value.forEach((item, index) => {
      out.push({ parent: value, key: index });
      collectPaths(item, out, depth + 1);
    });
  } else if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_WALK_WIDTH) return;
    for (const key of keys) {
      out.push({ parent: value, key });
      collectPaths(value[key], out, depth + 1);
    }
  }
}

function readPath(path: Path): unknown {
  return Array.isArray(path.parent)
    ? path.parent[path.key as number]
    : path.parent[path.key as string];
}

function writePath(path: Path, value: unknown): void {
  if (Array.isArray(path.parent)) path.parent[path.key as number] = value;
  else path.parent[path.key as string] = value;
}

export const MUTATION_KINDS = [
  'replace_weird',
  'delete',
  'future_schema_key',
  'inject_proto',
  'swap_array_object',
  'numeric_edge',
  'stringify',
  'toggle_bool',
  'truncate_string',
  'inflate_string',
  'unicode_variant',
  'wrap_array',
  'null_out',
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

export interface MutationRecord {
  kind: MutationKind;
  path: string;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '<unserialisable>';
  }
}

function pathLabel(path: Path): string {
  return String(path.key);
}

/** Deep-clones `base` and applies `count` random structural mutations,
 * returning the mutated value and a human-readable mutation log. */
export function mutate(
  rng: Rng,
  base: Json,
  count: number,
): { value: unknown; mutations: MutationRecord[] } {
  const value: unknown = clone(base);
  const mutations: MutationRecord[] = [];
  if (count <= 0) return { value, mutations };
  const root: Record<string, unknown> = { root: value };
  for (let i = 0; i < count; i++) {
    const paths: Path[] = [{ parent: root, key: 'root' }];
    collectPaths(root['root'], paths);
    const path = rng.pick(paths);
    const kind = rng.pick(MUTATION_KINDS);
    const current = readPath(path);
    mutations.push({ kind, path: pathLabel(path) });
    switch (kind) {
      case 'replace_weird':
        writePath(path, weirdValue(rng));
        break;
      case 'delete':
        if (Array.isArray(path.parent))
          path.parent.splice(path.key as number, 1);
        else delete path.parent[path.key as string];
        break;
      case 'future_schema_key':
        if (isPlainObject(current)) {
          current[
            rng.pick(['schemaVersion', 'v2', 'extra', '__typename', 'meta'])
          ] = rng.pick([99, 'future', { nested: true }, [1, 2, 3]]);
        } else {
          writePath(path, { schemaVersion: 99, value: current });
        }
        break;
      case 'inject_proto':
        if (isPlainObject(current)) {
          Object.defineProperty(current, '__proto__', {
            value: { polluted: 'yes' },
            enumerable: true,
            configurable: true,
            writable: true,
          });
        } else {
          writePath(path, pollutionObject(rng));
        }
        break;
      case 'swap_array_object':
        if (Array.isArray(current)) {
          const record: Record<string, unknown> = {};
          current.forEach((item, index) => {
            record[String(index)] = item;
          });
          writePath(path, record);
        } else if (isPlainObject(current)) {
          writePath(path, Object.values(current));
        } else {
          writePath(path, [current]);
        }
        break;
      case 'numeric_edge':
        writePath(path, rng.pick(WEIRD_NUMBERS));
        break;
      case 'stringify':
        writePath(
          path,
          typeof current === 'string' ? current : safeStringify(current),
        );
        break;
      case 'toggle_bool':
        writePath(
          path,
          typeof current === 'boolean' ? !current : rng.pick([true, false]),
        );
        break;
      case 'truncate_string':
        if (typeof current === 'string' && current.length > 0) {
          writePath(path, current.slice(0, rng.int(0, current.length - 1)));
        } else {
          writePath(path, '');
        }
        break;
      case 'inflate_string':
        writePath(
          path,
          (typeof current === 'string' ? current : '') +
            rng.pick([HUGE_STRING, HUGE_UNICODE, HUGE_GRAPHEMES]),
        );
        break;
      case 'unicode_variant':
        if (typeof current === 'string') {
          writePath(
            path,
            rng.pick([
              current.normalize('NFD'),
              current.normalize('NFKC'),
              current + '\u200b',
              '\uFEFF' + current,
              current.toUpperCase(),
              current.replace(/i/g, '\u0131'),
              current.replace(/a/g, '\u0430'),
            ]),
          );
        } else {
          writePath(path, rng.pick(WEIRD_STRINGS));
        }
        break;
      case 'wrap_array':
        writePath(path, [current]);
        break;
      case 'null_out':
        writePath(path, rng.chance(0.5) ? null : undefined);
        break;
    }
  }
  return { value: root['root'], mutations };
}

// ─── Malformed JSON text ─────────────────────────────────────────────────────

export const TEXT_CORRUPTIONS = [
  'truncate',
  'trailing_garbage',
  'bom_prefix',
  'null_byte',
  'nan_literal',
  'trailing_comma',
  'single_quotes',
  'python_bool',
  'duplicate_key',
  'deep_nesting',
  'empty',
  'html',
  'undefined_literal',
  'unterminated_string',
  'lone_surrogate_escape',
  'huge_number',
] as const;
export type TextCorruption = (typeof TEXT_CORRUPTIONS)[number];

/** Serialises `value` and corrupts the text; the result may or may not still
 * be valid JSON (that is part of the point). */
export function corruptJsonText(
  rng: Rng,
  value: unknown,
  kind: TextCorruption,
): string {
  const text = JSON.stringify(value) ?? 'undefined';
  switch (kind) {
    case 'truncate':
      return text.slice(0, rng.int(0, Math.max(0, text.length - 1)));
    case 'trailing_garbage':
      return (
        text + rng.pick(['}', ']', 'x', '{"a":1}', '\u0000', ' // comment'])
      );
    case 'bom_prefix':
      return '\uFEFF' + text;
    case 'null_byte':
      return (
        text.slice(0, Math.floor(text.length / 2)) +
        '\u0000' +
        text.slice(Math.floor(text.length / 2))
      );
    case 'nan_literal':
      return text.replace(
        /\d+(\.\d+)?/,
        rng.pick(['NaN', 'Infinity', '-Infinity']),
      );
    case 'trailing_comma':
      return text.replace(/}$/, ',}').replace(/]$/, ',]');
    case 'single_quotes':
      return text.replace(/"/g, "'");
    case 'python_bool':
      return text
        .replace(/true/g, 'True')
        .replace(/false/g, 'False')
        .replace(/null/g, 'None');
    case 'duplicate_key':
      return text.replace(/^\{/, '{"premium":true,"premium":false,');
    case 'deep_nesting': {
      const depth = rng.pick([1000, 50_000, 200_000]);
      return '['.repeat(depth) + text + ']'.repeat(depth);
    }
    case 'empty':
      return rng.pick(['', ' ', '\n']);
    case 'html':
      return '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>';
    case 'undefined_literal':
      return text.replace(/(true|false|null|\d+)/, 'undefined');
    case 'unterminated_string':
      return text.replace(/"([^"]*)"\s*:/, '"$1:');
    case 'lone_surrogate_escape':
      return text.replace(/^\{/, '{"k":"\\ud800",');
    case 'huge_number':
      return text.replace(/\d+(\.\d+)?/, '1' + '0'.repeat(400));
  }
}

// ─── Reference predicates (the contract in src/billing/types.ts) ──────────────

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function isCoherentAccess(
  value: unknown,
): value is CanonicalAccessState {
  if (!isPlainRecord(value)) return false;
  const fr = value['freeRatings'];
  if (!isPlainRecord(fr)) return false;
  const entitlements = value['entitlements'];
  if (
    typeof value['premium'] !== 'boolean' ||
    !Array.isArray(entitlements) ||
    !entitlements.every(item => typeof item === 'string') ||
    typeof value['canStartRating'] !== 'boolean' ||
    typeof value['paywallRequired'] !== 'boolean' ||
    fr['limit'] !== 2 ||
    !isSafeInt(fr['used']) ||
    !isSafeInt(fr['reserved']) ||
    !isSafeInt(fr['remaining']) ||
    !isSafeInt(fr['availableToReserve'])
  ) {
    return false;
  }
  const used = fr['used'];
  const reserved = fr['reserved'];
  const remaining = fr['remaining'];
  const available = fr['availableToReserve'];
  if (used < 0 || used > 2) return false;
  if (reserved < 0) return false;
  if (remaining !== 2 - used) return false;
  if (reserved > remaining) return false;
  if (available !== remaining - reserved) return false;
  const premium = value['premium'];
  if (premium !== entitlements.includes('premium')) return false;
  const canStart = premium || available > 0;
  if (value['canStartRating'] !== canStart) return false;
  if (value['paywallRequired'] !== !canStart) return false;
  return true;
}

export function isCoherentBilling(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (typeof value['premium'] !== 'boolean') return false;
  const productKey = value['productKey'];
  if (!(productKey === null || typeof productKey === 'string')) return false;
  const expiresAt = value['expiresAt'];
  if (!(expiresAt === null || isParseableDate(expiresAt))) return false;
  return isParseableDate(value['verifiedAt']);
}

export function isParseableDate(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

export const BILLING_ERROR_CODES = new Set<string>([
  'billing.unconfigured',
  'billing.offerings_unavailable',
  'billing.purchase_cancelled',
  'billing.purchase_failed',
  'billing.restore_failed',
  'billing.backend_unconfigured',
  'billing.backend_unavailable',
  'billing.backend_invalid_response',
  'billing.backend_verification_pending',
]);

export const UNCONFIGURED_REASONS = new Set<string>([
  'missing_public_sdk_key',
  'missing_canonical_app_user_id',
  'invalid_canonical_app_user_id',
  'secret_key_supplied_to_client',
  'missing_api_base_url',
  'missing_api_token',
]);

/** True only for a well-formed BillingError: enumerated code, non-empty
 * message, boolean retryable, and an enumerated reason when present. */
export function isTypedBillingError(error: unknown): error is BillingError {
  if (!(error instanceof BillingError)) return false;
  if (!BILLING_ERROR_CODES.has(error.code)) return false;
  if (typeof error.message !== 'string' || error.message.length === 0)
    return false;
  if (typeof error.retryable !== 'boolean') return false;
  if (
    error.unconfiguredReason !== undefined &&
    !UNCONFIGURED_REASONS.has(error.unconfiguredReason)
  ) {
    return false;
  }
  return true;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.constructor.name}: ${error.message.slice(0, 200)}`;
  }
  let rendered: string;
  try {
    rendered = String(error);
  } catch {
    rendered = '<no toString>';
  }
  return `non-error throw: ${typeof error} ${rendered.slice(0, 100)}`;
}

// ─── Prototype pollution guard ───────────────────────────────────────────────

export function pollutionProbe(): string | null {
  const probe = {} as { polluted?: unknown };
  if (probe.polluted !== undefined) return 'Object.prototype.polluted is set';
  if (([] as { polluted?: unknown }).polluted !== undefined) {
    return 'Array.prototype.polluted is set';
  }
  if (Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')) {
    return 'Object.prototype has own key "polluted"';
  }
  if (Object.keys(Object.prototype).length !== 0) {
    return `Object.prototype gained enumerable keys: ${Object.keys(Object.prototype).join(',')}`;
  }
  if (Object.keys(Array.prototype).length !== 0) {
    return `Array.prototype gained enumerable keys: ${Object.keys(Array.prototype).join(',')}`;
  }
  return null;
}

// ─── Deferred (for interleavings) ────────────────────────────────────────────

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  const d: Deferred<T> = {
    promise,
    settled: false,
    resolve(value) {
      d.settled = true;
      resolveFn(value);
    },
    reject(reason) {
      d.settled = true;
      rejectFn(reason);
    },
  };
  // A deferred that is never awaited must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return d;
}

/** Lets every already-queued microtask (and one macrotask) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>(res => setTimeout(res, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ─── Result table ────────────────────────────────────────────────────────────

export interface StressRow {
  seed: number;
  scenario: string;
  outcome: 'held' | 'broken';
  failures: string[];
  detail: Record<string, unknown>;
  wallMs: number;
}

export function replayCommand(suiteFile: string, seed: number): string {
  return `cd apps/mobile && STRESS_ONLY=${seed} npx jest --ci __tests__/stress/${suiteFile}`;
}

export function writeTable(
  config: StressConfig,
  suite: string,
  rows: StressRow[],
  extra: Record<string, unknown>,
): { summaryPath: string; tablePath: string } {
  mkdirSync(config.outDir, { recursive: true });
  const failed = rows.filter(r => r.outcome === 'broken');
  const byFailure: Record<string, number> = {};
  for (const row of failed) {
    for (const f of row.failures) {
      const key = f.split(':')[0] ?? f;
      byFailure[key] = (byFailure[key] ?? 0) + 1;
    }
  }
  const summary = {
    suite,
    generatedAt: new Date().toISOString(),
    iterations: config.iterations,
    baseSeed: config.baseSeed,
    only: config.only,
    executed: rows.length,
    held: rows.length - failed.length,
    broken: failed.length,
    byFailure,
    failingSeeds: failed.map(r => r.seed),
    maxWallMs: rows.reduce((m, r) => Math.max(m, r.wallMs), 0),
    ...extra,
  };
  const summaryPath = join(config.outDir, `${suite}.summary.json`);
  const tablePath = join(config.outDir, `${suite}.table.json`);
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  writeFileSync(
    tablePath,
    JSON.stringify(
      rows.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        scenario: r.scenario,
        failures: r.failures,
        wallMs: r.wallMs,
        detail: r.detail,
      })),
    ),
  );
  return { summaryPath, tablePath };
}

/** Compact, JSON-safe rendering of a generated value for the table. */
export function summarize(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 64
      ? `<string len=${value.length}> ${JSON.stringify(value.slice(0, 24))}…`
      : value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
    return value;
  }
  if (value === undefined) return '<undefined>';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '<function>';
  if (typeof value === 'symbol') return '<symbol>';
  if (typeof value === 'bigint') return `${value}n`;
  if (Array.isArray(value)) {
    if (depth > 3) return `<array len=${value.length}>`;
    return value.length > 8
      ? [
          ...value.slice(0, 8).map(v => summarize(v, depth + 1)),
          `<+${value.length - 8}>`,
        ]
      : value.map(v => summarize(v, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 3) return '<object>';
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as object);
    for (const key of keys.slice(0, 12)) {
      out[key.length > 32 ? `<key len=${key.length}>` : key] = summarize(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
    }
    if (keys.length > 12) out['<more>'] = keys.length - 12;
    return out;
  }
  return String(value);
}
