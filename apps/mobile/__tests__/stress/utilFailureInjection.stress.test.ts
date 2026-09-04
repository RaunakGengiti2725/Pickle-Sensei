/**
 * STRESS / failure-injection — `src/util/uuid.ts` + `src/util/plural.ts`.
 *
 * `makeUuid()` depends on two globals: `globalThis.crypto.getRandomValues`
 * and `Math.random`. Each seeded iteration replaces BOTH with a fault
 * (absent / throws / fills nothing / fills partially / returns a different
 * buffer / degenerate or out-of-range Math.random) and checks:
 *
 *  U1 shape      every id produced is a canonical RFC-4122 v4 string
 *                (8-4-4-4-12 lowercase hex, version nibble 4, variant 8-b).
 *  U2 no-throw   with a NON-throwing entropy source the call never throws.
 *  U3 fallback   with `crypto` absent, `Math.random` supplies the bytes.
 *  U4 unique     with a working entropy source, 256 ids in a row are unique.
 *  U5 no-leak    the faulted globals are restored after each iteration.
 *
 * `plural()` has no dependencies; it is fuzzed with hostile counts (NaN, ±0,
 * ±Infinity, negatives, fractions, huge values, Number.MIN_VALUE) and
 * hostile strings (empty, whitespace, emoji, RTL, very long):
 *
 *  P1 exactly-one only `count === 1` yields the singular.
 *  P2 default     the default plural is `${singular}s`, byte for byte.
 *  P3 explicit    an explicit plural form is returned unchanged.
 *
 * Scale:  STRESS_ITER=<n> iterations (default 300; campaign used 5000)
 * Replay: STRESS_SEED=<seed>
 * Output: STRESS_OUT=<dir> → util-failure-injection.json
 */

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

import { makeUuid } from '../../src/util/uuid';
import { plural } from '../../src/util/plural';

const ITERATIONS = Number(process.env.STRESS_ITER ?? 300);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(__dirname, '..', '..', '..', '..', 'artifacts', 'stress');

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

// ── fault catalogue ───────────────────────────────────────────────────────

const CRYPTO_FAULTS = [
  'ok',
  'absent', // globalThis.crypto undefined (older Hermes without polyfill)
  'no-get-random-values', // crypto object without getRandomValues
  'throws', // QuotaExceededError-style throw
  'fills-nothing', // returns the buffer untouched (all zero)
  'fills-half', // only the first 8 bytes are randomised
  'returns-other-buffer', // fills and returns a DIFFERENT Uint8Array
  'fills-with-255', // every byte 0xff
  'returns-undefined', // fills, returns undefined (violates the spec type)
] as const;
type CryptoFault = (typeof CRYPTO_FAULTS)[number];

const RANDOM_FAULTS = [
  'ok', // seeded uniform [0, 1)
  'always-zero',
  'always-max', // 1 - 2^-53
  'returns-one', // out of contract: exactly 1 → byte 256 → wraps
  'returns-nan',
  'returns-negative',
  'returns-huge', // 1e9
] as const;
type RandomFault = (typeof RANDOM_FAULTS)[number];

interface Plan {
  seed: number;
  crypto: CryptoFault;
  random: RandomFault;
  calls: number;
}

function planFor(seed: number): Plan {
  const rng = mulberry32(seed);
  return {
    seed,
    crypto: pick(rng, CRYPTO_FAULTS),
    random: pick(rng, RANDOM_FAULTS),
    calls: 1 + Math.floor(rng() * 256),
  };
}

// ── harness ───────────────────────────────────────────────────────────────

interface Failure {
  invariant: string;
  detail: string;
}

interface Row extends Plan {
  ok: boolean;
  failures: Failure[];
  produced: number;
  threw: string | null;
  sample: string | null;
}

const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalRandom = Math.random;
const results: Row[] = [];
const wallStart = Date.now();

function installCrypto(fault: CryptoFault, rng: () => number): void {
  const fill = (a: Uint8Array, n: number, byte?: number) => {
    for (let i = 0; i < n; i++) a[i] = byte ?? Math.floor(rng() * 256);
  };
  let value: unknown;
  switch (fault) {
    case 'ok':
      value = {
        getRandomValues: (a: Uint8Array) => {
          fill(a, a.length);
          return a;
        },
      };
      break;
    case 'absent':
      value = undefined;
      break;
    case 'no-get-random-values':
      value = { subtle: {} };
      break;
    case 'throws':
      value = {
        getRandomValues: () => {
          throw new Error('QuotaExceededError: getRandomValues unavailable');
        },
      };
      break;
    case 'fills-nothing':
      value = { getRandomValues: (a: Uint8Array) => a };
      break;
    case 'fills-half':
      value = {
        getRandomValues: (a: Uint8Array) => {
          fill(a, Math.floor(a.length / 2));
          return a;
        },
      };
      break;
    case 'returns-other-buffer':
      value = {
        getRandomValues: (a: Uint8Array) => {
          fill(a, a.length);
          const other = new Uint8Array(a.length);
          fill(other, other.length);
          return other;
        },
      };
      break;
    case 'fills-with-255':
      value = {
        getRandomValues: (a: Uint8Array) => {
          fill(a, a.length, 0xff);
          return a;
        },
      };
      break;
    case 'returns-undefined':
      value = {
        getRandomValues: (a: Uint8Array) => {
          fill(a, a.length);
          return undefined;
        },
      };
      break;
  }
  Object.defineProperty(globalThis, 'crypto', {
    value,
    configurable: true,
    writable: true,
  });
}

function installRandom(fault: RandomFault, rng: () => number): void {
  switch (fault) {
    case 'ok':
      Math.random = rng;
      break;
    case 'always-zero':
      Math.random = () => 0;
      break;
    case 'always-max':
      Math.random = () => 1 - Number.EPSILON / 2;
      break;
    case 'returns-one':
      Math.random = () => 1;
      break;
    case 'returns-nan':
      Math.random = () => Number.NaN;
      break;
    case 'returns-negative':
      Math.random = () => -0.5;
      break;
    case 'returns-huge':
      Math.random = () => 1e9;
      break;
  }
}

function restoreGlobals(): void {
  if (originalCrypto)
    Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete (globalThis as { crypto?: unknown }).crypto;
  Math.random = originalRandom;
}

function cryptoUsable(fault: CryptoFault): boolean {
  return fault !== 'absent' && fault !== 'no-get-random-values';
}

function runUuidIteration(plan: Plan): Row {
  const failures: Failure[] = [];
  const fail = (invariant: string, detail: string) =>
    failures.push({ invariant, detail });
  const rng = mulberry32(plan.seed ^ 0x9e3779b9);
  installCrypto(plan.crypto, rng);
  installRandom(plan.random, rng);

  const ids: string[] = [];
  let threw: string | null = null;
  try {
    for (let i = 0; i < plan.calls; i++) ids.push(makeUuid());
  } catch (error) {
    threw = (error as Error).message;
  } finally {
    restoreGlobals();
  }

  // U5 — globals restored.
  if (Math.random !== originalRandom)
    fail('U5-no-leak', 'Math.random not restored');
  if (
    Object.getOwnPropertyDescriptor(globalThis, 'crypto')?.value !==
    originalCrypto?.value
  ) {
    fail('U5-no-leak', 'globalThis.crypto not restored');
  }

  const expectThrow = plan.crypto === 'throws';
  // U2 — only a throwing entropy source may make makeUuid throw.
  if (threw !== null && !expectThrow) {
    fail('U2-no-throw', `makeUuid threw: ${threw}`);
  }
  if (threw === null && expectThrow) {
    fail(
      'U2-no-throw',
      'expected the injected getRandomValues throw to propagate',
    );
  }
  // U1 — shape.
  for (const id of ids) {
    if (!UUID_V4.test(id)) {
      fail('U1-shape', `non-v4 id ${JSON.stringify(id)}`);
      break;
    }
  }
  if (threw === null && ids.length !== plan.calls) {
    fail('U1-shape', `produced ${ids.length}/${plan.calls}`);
  }
  // U3 — fallback path actually used Math.random when crypto is unusable.
  // U4 — uniqueness whenever the entropy that actually feeds the bytes is
  // sound (crypto ok/half/other-buffer/undefined-return, or Math.random ok
  // on the fallback path).
  const entropySound = cryptoUsable(plan.crypto)
    ? plan.crypto === 'ok' ||
      plan.crypto === 'fills-half' ||
      plan.crypto === 'returns-undefined' ||
      plan.crypto === 'returns-other-buffer'
    : plan.random === 'ok';
  if (entropySound && ids.length > 1 && new Set(ids).size !== ids.length) {
    fail('U4-unique', `${ids.length - new Set(ids).size} duplicate ids`);
  }
  if (!cryptoUsable(plan.crypto) && plan.random === 'always-zero' && ids[0]) {
    if (ids[0] !== '00000000-0000-4000-8000-000000000000') {
      fail('U3-fallback', `fallback with zero entropy gave ${ids[0]}`);
    }
  }

  return {
    ...plan,
    ok: failures.length === 0,
    failures,
    produced: ids.length,
    threw,
    sample: ids[0] ?? null,
  };
}

// ── plural fuzz ───────────────────────────────────────────────────────────

const HOSTILE_COUNTS = [
  1,
  1.0,
  0,
  -0,
  -1,
  2,
  1.5,
  0.999999999,
  1.0000000000000002,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  -273.15,
  1e21,
  Number.EPSILON,
];

const HOSTILE_WORDS = [
  '',
  ' ',
  'rally',
  'match',
  'volley',
  'dink',
  'try',
  'Ратинг',
  '評価',
  'שגיאה',
  '🥒',
  'a'.repeat(10_000),
  '\u0000',
  '\n',
];

interface PluralRow {
  seed: number;
  count: number | string;
  singular: string;
  explicit: string | null;
  ok: boolean;
  failures: Failure[];
}

const pluralResults: PluralRow[] = [];

function runPluralIteration(seed: number): PluralRow {
  const rng = mulberry32(seed ^ 0x51ed270b);
  const count = rng() < 0.7 ? pick(rng, HOSTILE_COUNTS) : rng() * 2e6 - 1e6;
  const singular = pick(rng, HOSTILE_WORDS);
  const explicit = rng() < 0.5 ? pick(rng, HOSTILE_WORDS) : null;
  const failures: Failure[] = [];
  const fail = (invariant: string, detail: string) =>
    failures.push({ invariant, detail });

  const out =
    explicit === null
      ? plural(count, singular)
      : plural(count, singular, explicit);
  if (typeof out !== 'string') {
    fail('P1-exactly-one', `non-string result ${String(out)}`);
  }
  if (count === 1) {
    if (out !== singular)
      fail('P1-exactly-one', `count 1 gave ${JSON.stringify(out)}`);
  } else if (explicit === null) {
    if (out !== `${singular}s`)
      fail('P2-default', `count ${count} gave ${JSON.stringify(out)}`);
  } else if (out !== explicit) {
    fail('P3-explicit', `count ${count} gave ${JSON.stringify(out)}`);
  }
  return {
    seed,
    count: Number.isFinite(count) ? count : String(count),
    singular:
      singular.length > 32
        ? `${singular.slice(0, 32)}…(${singular.length})`
        : singular,
    explicit:
      explicit !== null && explicit.length > 32
        ? `${explicit.slice(0, 32)}…(${explicit.length})`
        : explicit,
    ok: failures.length === 0,
    failures,
  };
}

// ── campaign ──────────────────────────────────────────────────────────────

function seeds(): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: ITERATIONS }, (_, i) => 2000 + i);
}

afterAll(() => {
  const failed = results.filter(r => !r.ok);
  const pluralFailed = pluralResults.filter(r => !r.ok);
  const byInvariant: Record<string, number[]> = {};
  for (const r of results)
    for (const f of r.failures) (byInvariant[f.invariant] ??= []).push(r.seed);
  for (const r of pluralResults)
    for (const f of r.failures) (byInvariant[f.invariant] ??= []).push(r.seed);
  const summary = {
    generatedAt: new Date().toISOString(),
    unit: 'apps/mobile/src/util/{uuid,plural}.ts',
    lens: 'failure-injection',
    iterations: ITERATIONS,
    onlySeed: ONLY_SEED,
    uuid: {
      executed: results.length,
      idsProduced: results.reduce((n, r) => n + r.produced, 0),
      passed: results.length - failed.length,
      failed: failed.length,
      faultsCovered: {
        crypto: [...new Set(results.map(r => r.crypto))].sort(),
        random: [...new Set(results.map(r => r.random))].sort(),
      },
    },
    plural: {
      executed: pluralResults.length,
      passed: pluralResults.length - pluralFailed.length,
      failed: pluralFailed.length,
    },
    wallMs: Date.now() - wallStart,
    byInvariant: Object.fromEntries(
      Object.entries(byInvariant).map(([k, v]) => [
        k,
        { count: v.length, seeds: v.slice(0, 50) },
      ]),
    ),
    uuidRows: results,
    pluralRows: pluralResults,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'util-failure-injection.json'),
    JSON.stringify(summary, null, 2),
  );
});

describe('makeUuid failure injection (seeded)', () => {
  it.each(seeds())('seed %i', seed => {
    const row = runUuidIteration(planFor(seed));
    results.push(row);
    expect(row.failures).toEqual([]);
  });
});

describe('plural hostile-input fuzz (seeded)', () => {
  it.each(seeds())('seed %i', seed => {
    const row = runPluralIteration(seed);
    pluralResults.push(row);
    expect(row.failures).toEqual([]);
  });
});
