/**
 * stress/mod-walkthrough-store-util · lens `boundary-malformed` · util/plural + util/uuid
 *
 * Seeded generated-input campaigns against the two pure helpers. Every
 * generated case is replayable from (STRESS_SEED, index); the per-case table
 * is written as JSON:
 *
 *   STRESS_SEED=<seed> STRESS_ITER=<n> npx jest __tests__/stress/utilPluralUuid.boundaryMalformed.stress.test.ts
 *
 * plural(count, singular, pluralForm?)
 *   counts: every IEEE-754 edge (NaN, ±Infinity, ±0, MIN_VALUE, EPSILON
 *   neighbours of 1, MAX_SAFE_INTEGER ± 1, 2^53 + 1, MAX_VALUE, subnormals),
 *   random integers/floats, and out-of-type runtime values (bigint, numeric
 *   strings, booleans, null, undefined, arrays/objects with valueOf → 1);
 *   labels: 64 KiB–256 KiB strings, NUL bytes, unicode normalisation pairs
 *   (NFC/NFD/NFKC), lone surrogates, ZWJ / bidi controls, path-traversal and
 *   prototype-key lookalikes, empty strings.
 *   Contract: the result is byte-identical to one of the three inputs
 *   (`singular`, the explicit `pluralForm`, or `singular + 's'`); `singular`
 *   is chosen iff `count === 1` (SameValueZero); labels are never
 *   normalised, trimmed, truncated or re-encoded; never throws for any
 *   in-type input; runtime-only wrong types (which TypeScript rejects) are
 *   recorded per class so the table shows exactly how each degrades.
 *
 * makeUuid()
 *   crypto shapes: real `globalThis.crypto`; seeded byte source; boundary
 *   fills (0x00, 0xFF, alternating, single-bit); `getRandomValues` that
 *   fills partially / returns a different array / returns nothing; `crypto`
 *   missing, null, primitive, empty object, `getRandomValues` undefined/null
 *   (→ Math.random fallback); seeded `Math.random` including out-of-contract
 *   returns (1, NaN, negative, Infinity, 256.5).
 *   Contract: 36-char lowercase RFC-4122 v4 string, version nibble 4,
 *   variant nibble in [89ab]; the other 122 bits are EXACTLY the injected
 *   bytes (nothing else is masked, no byte is reordered or dropped);
 *   exactly 16 bytes are requested; unique across the campaign; never
 *   throws for any of the above shapes. `getRandomValues` that itself throws
 *   or is a non-callable truthy value is a platform-contract violation and
 *   is recorded as its own class (the helper propagates it).
 *
 * Default scale is small so the suite stays fast; the recorded campaign uses
 * STRESS_ITER=3000 per campaign (the JSON artifacts hold every row).
 */

import { plural } from '../../src/util/plural';
import { makeUuid } from '../../src/util/uuid';

// Node built-ins, typed the way __tests__/xc/deepLinks.webviewGateAdversarial.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  writeFileSync: (p: string, data: string) => void;
  mkdirSync: (p: string, options: { recursive: true }) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };
const os = require('os') as { tmpdir: () => string };

const ARTIFACT_DIR =
  process.env.STRESS_ARTIFACT_DIR ??
  path.join(os.tmpdir(), 'stress-mod-walkthrough-store-util');
const STRESS_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const STRESS_ITER = Number(process.env.STRESS_ITER ?? 500);

function writeArtifact(name: string, data: unknown) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, name), JSON.stringify(data));
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function iterationSeed(index: number, salt: number): number {
  let h = (STRESS_SEED ^ salt ^ (index * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function int(rand: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rand() * (maxInclusive - min + 1));
}

function preview(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 60
      ? `${JSON.stringify(value.slice(0, 30))}…(len ${value.length})`
      : JSON.stringify(value);
  }
  if (typeof value === 'number')
    return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return 'function';
  try {
    return String(JSON.stringify(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// ---------------------------------------------------------------------------
// plural
// ---------------------------------------------------------------------------

const NUMERIC_EDGES: readonly number[] = [
  0,
  -0,
  1,
  -1,
  2,
  1 + Number.EPSILON,
  1 - Number.EPSILON / 2, // largest double below 1
  1 - Number.EPSILON,
  Number('0.99999999999999999'), // 17 nines: parses to exactly 1
  Number('1.0000000000000001'), // parses to exactly 1
  1.5,
  0.5,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  Number.EPSILON,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER + 2, // 2^53 + 1, not representable → 2^53
  -Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Infinity,
  -Infinity,
  NaN,
  2 ** 31,
  -(2 ** 31),
  2 ** 32,
  1e21, // String(1e21) is exponent form
  1e-7, // String(1e-7) is exponent form
  4.94e-324,
];

const LABEL_ATOMS: readonly string[] = [
  'day',
  'read',
  'clip',
  'active day',
  'daily average',
  '',
  ' ',
  '\u0000',
  'é',
  'e\u0301',
  'ﬁ',
  'Å',
  'A\u030a',
  '\u212b', // ANGSTROM SIGN — NFKC → Å
  '\u200d',
  '\u200b',
  '\u202e',
  '\u2066',
  '\ufeff',
  '👩‍👩‍👧‍👦',
  '🏓',
  '\ud83d',
  '\udc00',
  'ａ',
  '\u00a0',
  '\t',
  '\n',
  '\r\n',
  '\\',
  '"',
  "'",
  '`${x}`',
  '%s',
  '%d',
  '{0}',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  '../../etc/passwd',
  '..\\..\\',
  '%2e%2e/',
  '<script>',
  '&amp;',
  'ß', // toUpperCase → 'SS' (length change) — plural must not case-map
  'İ', // toLowerCase → 'i̇' (length change)
];

function label(rand: () => number): string {
  const shape = pick(rand, ['word', 'word', 'soup', 'huge', 'empty']);
  if (shape === 'empty') return '';
  if (shape === 'word') return pick(rand, LABEL_ATOMS);
  if (shape === 'soup') {
    let out = '';
    const n = int(rand, 1, 12);
    for (let i = 0; i < n; i += 1) out += pick(rand, LABEL_ATOMS);
    return out;
  }
  const kib = pick(rand, [64, 65, 128, 256]);
  const filler = pick(rand, ['a', '\u0000', 'é', '🏓', ' ']);
  let out = '';
  while (out.length < kib * 1024) out += filler;
  return out.slice(0, kib * 1024 + int(rand, 0, 3));
}

interface PluralRow {
  seed: number;
  index: number;
  countClass: string;
  count: string;
  singular: string;
  pluralForm: string | null;
  outcome: 'HELD' | 'BROKEN' | 'RUNTIME-TYPE';
  detail?: string;
}

function pluralIteration(index: number): PluralRow {
  const seed = iterationSeed(index, 0x70_6c_75_72);
  const rand = xorshift32(seed);
  const countClass = pick(rand, [
    'edge',
    'edge',
    'edge',
    'random-int',
    'random-float',
    'runtime-type',
  ]);
  let count: unknown;
  switch (countClass) {
    case 'edge':
      count = pick(rand, NUMERIC_EDGES);
      break;
    case 'random-int':
      count = int(rand, -1_000_000, 1_000_000);
      break;
    case 'random-float':
      count = (rand() - 0.5) * 2 ** int(rand, -60, 60);
      break;
    default:
      count = pick(rand, [
        1n,
        0n,
        '1',
        '01',
        ' 1 ',
        '1e0',
        true,
        false,
        null,
        undefined,
        [1],
        [],
        { valueOf: () => 1 },
        { toString: () => '1' },
        Object(1),
      ]);
  }
  const singular = label(rand);
  const withPlural = rand() < 0.5;
  const pluralForm = withPlural ? label(rand) : undefined;

  const row: PluralRow = {
    seed,
    index,
    countClass,
    count: preview(count),
    singular: preview(singular),
    pluralForm: withPlural ? preview(pluralForm) : null,
    outcome: 'HELD',
  };
  const inType = typeof count === 'number';
  let result: string;
  try {
    result = withPlural
      ? plural(count as number, singular, pluralForm)
      : plural(count as number, singular);
  } catch (error) {
    row.outcome = inType ? 'BROKEN' : 'RUNTIME-TYPE';
    row.detail = `threw ${error instanceof Error ? error.message : String(error)}`;
    return row;
  }
  const expected =
    count === 1 ? singular : withPlural ? pluralForm! : `${singular}s`;
  if (typeof result !== 'string') {
    row.outcome = 'BROKEN';
    row.detail = `non-string result ${preview(result)}`;
  } else if (result !== expected) {
    row.outcome = 'BROKEN';
    row.detail = `result ${preview(result)} ≠ expected ${preview(expected)}`;
  } else if (!inType) {
    // Degraded gracefully: still a string chosen from the inputs.
    row.outcome = 'RUNTIME-TYPE';
    row.detail = count === 1 ? 'singular' : 'plural';
  }
  return row;
}

describe('util/plural · boundary-malformed stress (seeded)', () => {
  it(`campaign: STRESS_ITER=${STRESS_ITER} generated (count, singular, pluralForm) triples`, () => {
    const rows: PluralRow[] = [];
    const byClass: Record<string, number> = {};
    for (let index = 0; index < STRESS_ITER; index += 1) {
      const row = pluralIteration(index);
      rows.push(row);
      const key = `${row.countClass}:${row.outcome}`;
      byClass[key] = (byClass[key] ?? 0) + 1;
    }
    const broken = rows.filter(r => r.outcome === 'BROKEN');
    writeArtifact('util-plural-boundary-malformed.json', {
      seed: STRESS_SEED,
      iterations: STRESS_ITER,
      held: rows.filter(r => r.outcome === 'HELD').length,
      runtimeType: rows.filter(r => r.outcome === 'RUNTIME-TYPE').length,
      broken: broken.length,
      byClass,
      replay:
        'STRESS_SEED=<seed> STRESS_ITER=<index+1> npx jest __tests__/stress/utilPluralUuid.boundaryMalformed.stress.test.ts -t plural',
      brokenRows: broken,
      rows,
    });
    expect(broken.slice(0, 20)).toEqual([]);
    expect(rows.length).toBe(STRESS_ITER);
  });

  it('every IEEE-754 edge count: only the exact integer 1 selects the singular', () => {
    for (const count of NUMERIC_EDGES) {
      const result = plural(count, 'day');
      expect(result).toBe(count === 1 ? 'day' : 'days');
    }
    // Literals that parse to exactly 1 ARE 1.
    expect(plural(Number('0.99999999999999999'), 'day')).toBe('day');
    expect(plural(Number('1.0000000000000001'), 'day')).toBe('day');
    // Representable neighbours are plural — the caller renders the number, so
    // "1.0000000000000002 days" is the honest label.
    expect(plural(1 + Number.EPSILON, 'day')).toBe('days');
    expect(plural(1 - Number.EPSILON / 2, 'day')).toBe('days');
    expect(plural(-0, 'day')).toBe('days');
    expect(plural(NaN, 'day')).toBe('days');
  });

  it('labels pass through byte-identical: no normalisation, trimming, case-mapping or truncation', () => {
    const nfd = 'e\u0301';
    expect(plural(1, nfd)).toBe(nfd);
    expect(plural(1, nfd).normalize('NFC')).not.toBe(plural(1, nfd));
    expect(plural(2, '\u212b')).toBe('\u212bs');
    expect(plural(2, 'ß')).toBe('ßs');
    expect(plural(1, ' padded ')).toBe(' padded ');
    const huge = '\u0000'.repeat(256 * 1024 + 1);
    expect(plural(2, huge)).toBe(`${huge}s`);
    expect(plural(2, huge).length).toBe(huge.length + 1);
    expect(plural(1, '\ud83d')).toBe('\ud83d');
    expect(plural(2, '', '')).toBe('');
    expect(plural(2, '')).toBe('s');
  });

  it('runtime wrong-type counts (rejected by TypeScript) degrade to the plural form, never throw', () => {
    for (const count of [
      1n,
      '1',
      true,
      null,
      undefined,
      [1],
      { valueOf: () => 1 },
    ]) {
      expect(plural(count as unknown as number, 'day')).toBe('days');
    }
  });
});

// ---------------------------------------------------------------------------
// makeUuid
// ---------------------------------------------------------------------------

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Independent formatter: what the RFC-4122 v4 string for these bytes is. */
function expectedUuid(bytes: Uint8Array): string {
  const masked = Uint8Array.from(bytes);
  masked[6] = (masked[6]! & 0x0f) | 0x40;
  masked[8] = (masked[8]! & 0x3f) | 0x80;
  const hex = Array.from(masked, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type CryptoSlot = { crypto?: unknown };
const globalSlot = globalThis as CryptoSlot;
const realCrypto = globalSlot.crypto;
const realMathRandom = Math.random;

function setCrypto(value: unknown, present: boolean) {
  if (present) {
    Object.defineProperty(globalSlot, 'crypto', {
      value,
      configurable: true,
      writable: true,
    });
  } else {
    delete globalSlot.crypto;
  }
}

function restoreCrypto() {
  Object.defineProperty(globalSlot, 'crypto', {
    value: realCrypto,
    configurable: true,
    writable: true,
  });
  Math.random = realMathRandom;
}

interface UuidRow {
  seed: number;
  index: number;
  shape: string;
  outcome: 'HELD' | 'BROKEN' | 'PLATFORM-CONTRACT';
  uuid?: string;
  requested?: number;
  detail?: string;
}

function fillFrom(rand: () => number, pattern: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 16; i += 1) {
    switch (pattern) {
      case 'zero':
        bytes.push(0);
        break;
      case 'ff':
        bytes.push(0xff);
        break;
      case 'alternating':
        bytes.push(i % 2 ? 0xff : 0x00);
        break;
      case 'single-bit':
        bytes.push(1 << (i % 8));
        break;
      case 'version-variant-hostile':
        // Bytes 6/8 carry the bits the helper must overwrite.
        bytes.push(i === 6 ? 0xff : i === 8 ? 0x7f : int(rand, 0, 255));
        break;
      default:
        bytes.push(int(rand, 0, 255));
    }
  }
  return bytes;
}

function uuidIteration(index: number, seen: Set<string>): UuidRow {
  const seed = iterationSeed(index, 0x75_75_69_64);
  const rand = xorshift32(seed);
  const shape = pick(rand, [
    'seeded-bytes',
    'seeded-bytes',
    'seeded-bytes',
    'boundary-fill',
    'partial-fill',
    'returns-other-array',
    'returns-nothing',
    'no-crypto',
    'crypto-null',
    'crypto-primitive',
    'crypto-empty-object',
    'grv-undefined',
    'grv-null',
    'math-random-out-of-contract',
    'grv-throws',
    'grv-non-callable',
  ]);
  const row: UuidRow = { seed, index, shape, outcome: 'HELD' };
  const cap: {
    requested: number;
    injected: number[] | null;
    math: number[] | null;
  } = { requested: 0, injected: null, math: null };

  const grvFilling = (pattern: string) => (array: Uint8Array) => {
    cap.requested += array.length;
    cap.injected = fillFrom(rand, pattern);
    array.set(cap.injected.slice(0, array.length));
    return array;
  };

  try {
    switch (shape) {
      case 'seeded-bytes':
        setCrypto({ getRandomValues: grvFilling('random') }, true);
        break;
      case 'boundary-fill':
        setCrypto(
          {
            getRandomValues: grvFilling(
              pick(rand, [
                'zero',
                'ff',
                'alternating',
                'single-bit',
                'version-variant-hostile',
              ]),
            ),
          },
          true,
        );
        break;
      case 'partial-fill':
        setCrypto(
          {
            getRandomValues: (array: Uint8Array) => {
              cap.requested += array.length;
              const n = int(rand, 0, 15);
              cap.injected = fillFrom(rand, 'random').map((b, i) =>
                i < n ? b : 0,
              );
              array.set(cap.injected.slice(0, n));
              return array;
            },
          },
          true,
        );
        break;
      case 'returns-other-array':
        setCrypto(
          {
            getRandomValues: (array: Uint8Array) => {
              cap.requested += array.length;
              cap.injected = fillFrom(rand, 'random');
              array.set(cap.injected);
              return new Uint8Array(16).fill(0xee);
            },
          },
          true,
        );
        break;
      case 'returns-nothing':
        setCrypto(
          {
            getRandomValues: (array: Uint8Array) => {
              cap.requested += array.length;
              cap.injected = fillFrom(rand, 'random');
              array.set(cap.injected);
            },
          },
          true,
        );
        break;
      case 'no-crypto':
        setCrypto(undefined, false);
        break;
      case 'crypto-null':
        setCrypto(null, true);
        break;
      case 'crypto-primitive':
        setCrypto(pick(rand, ['crypto', 42, true, 0n, Symbol('crypto')]), true);
        break;
      case 'crypto-empty-object':
        setCrypto(pick(rand, [{}, [], Object.create(null)]), true);
        break;
      case 'grv-undefined':
        setCrypto({ getRandomValues: undefined }, true);
        break;
      case 'grv-null':
        setCrypto({ getRandomValues: null }, true);
        break;
      case 'math-random-out-of-contract':
        setCrypto(undefined, false);
        break;
      case 'grv-throws':
        setCrypto(
          {
            getRandomValues: () => {
              throw new Error('QuotaExceededError');
            },
          },
          true,
        );
        break;
      default:
        setCrypto(
          { getRandomValues: pick(rand, [1, 'fn', true, {}, []]) },
          true,
        );
    }

    const usesFallback = [
      'no-crypto',
      'crypto-null',
      'crypto-primitive',
      'crypto-empty-object',
      'grv-undefined',
      'grv-null',
      'math-random-out-of-contract',
    ].includes(shape);
    if (usesFallback) {
      const seq: number[] = [];
      cap.math = seq;
      const hostile = shape === 'math-random-out-of-contract';
      Math.random = () => {
        const v = hostile
          ? pick(rand, [
              0,
              0.999_999_999,
              1,
              1.5,
              -0.5,
              NaN,
              Infinity,
              -Infinity,
              256.5,
              255.999,
            ])
          : rand();
        seq.push(v);
        return v;
      };
    }

    const uuid = makeUuid();
    row.uuid = uuid;
    row.requested = cap.requested;

    // Shapes whose 122 payload bits are fully seeded; anything else
    // (boundary fills, partial fills, hostile Math.random) may legitimately
    // repeat a value.
    const fullEntropy = [
      'seeded-bytes',
      'returns-other-array',
      'returns-nothing',
      'no-crypto',
      'crypto-null',
      'crypto-primitive',
      'crypto-empty-object',
      'grv-undefined',
      'grv-null',
    ].includes(shape);

    if (typeof uuid !== 'string' || !UUID_V4.test(uuid)) {
      row.outcome = 'BROKEN';
      row.detail = `not RFC-4122 v4: ${preview(uuid)}`;
    } else if (fullEntropy && seen.has(uuid)) {
      row.outcome = 'BROKEN';
      row.detail = 'duplicate uuid';
    } else if (cap.injected !== null) {
      const expected = expectedUuid(Uint8Array.from(cap.injected));
      if (cap.requested !== 16) {
        row.outcome = 'BROKEN';
        row.detail = `requested ${cap.requested} bytes, expected 16`;
      } else if (uuid !== expected) {
        row.outcome = 'BROKEN';
        row.detail = `bytes not preserved: got ${uuid}, expected ${expected}`;
      }
    } else if (cap.math !== null) {
      const seq = cap.math;
      if (seq.length !== 16) {
        row.outcome = 'BROKEN';
        row.detail = `Math.random called ${seq.length}×, expected 16`;
      } else if (shape !== 'math-random-out-of-contract') {
        const bytes = Uint8Array.from(seq.map(v => Math.floor(v * 256)));
        if (uuid !== expectedUuid(bytes)) {
          row.outcome = 'BROKEN';
          row.detail = 'fallback bytes not preserved';
        }
      }
    }
    seen.add(uuid);
  } catch (error) {
    const platformFault =
      shape === 'grv-throws' || shape === 'grv-non-callable';
    row.outcome = platformFault ? 'PLATFORM-CONTRACT' : 'BROKEN';
    row.detail = `threw ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    restoreCrypto();
  }
  return row;
}

describe('util/uuid · boundary-malformed stress (seeded)', () => {
  afterEach(restoreCrypto);

  it(`campaign: STRESS_ITER=${STRESS_ITER} generated crypto/Math.random shapes`, () => {
    const seen = new Set<string>();
    const rows: UuidRow[] = [];
    const byShape: Record<string, number> = {};
    for (let index = 0; index < STRESS_ITER; index += 1) {
      const row = uuidIteration(index, seen);
      rows.push(row);
      const key = `${row.shape}:${row.outcome}`;
      byShape[key] = (byShape[key] ?? 0) + 1;
    }
    const broken = rows.filter(r => r.outcome === 'BROKEN');
    const platform = rows.filter(r => r.outcome === 'PLATFORM-CONTRACT');
    writeArtifact('util-uuid-boundary-malformed.json', {
      seed: STRESS_SEED,
      iterations: STRESS_ITER,
      held: rows.filter(r => r.outcome === 'HELD').length,
      platformContract: platform.length,
      broken: broken.length,
      byShape,
      replay:
        'STRESS_SEED=<seed> STRESS_ITER=<index+1> npx jest __tests__/stress/utilPluralUuid.boundaryMalformed.stress.test.ts -t uuid',
      brokenRows: broken,
      rows,
    });
    expect(broken.slice(0, 20)).toEqual([]);
    // Every platform-contract row is one of the two documented throwing shapes.
    expect(
      platform.filter(
        r => r.shape !== 'grv-throws' && r.shape !== 'grv-non-callable',
      ),
    ).toEqual([]);
    expect(rows.length).toBe(STRESS_ITER);
  });

  it('real platform crypto: STRESS_ITER×4 uuids are v4, lowercase, unique', () => {
    const n = STRESS_ITER * 4;
    const seen = new Set<string>();
    for (let i = 0; i < n; i += 1) {
      const uuid = makeUuid();
      expect(uuid).toMatch(UUID_V4);
      expect(uuid).toBe(uuid.toLowerCase());
      seen.add(uuid);
    }
    expect(seen.size).toBe(n);
  });

  it('boundary byte fills: only the version and variant nibbles are rewritten', () => {
    const cases: Array<[number[], string]> = [
      [new Array<number>(16).fill(0), '00000000-0000-4000-8000-000000000000'],
      [
        new Array<number>(16).fill(0xff),
        'ffffffff-ffff-4fff-bfff-ffffffffffff',
      ],
      [
        Array.from({ length: 16 }, (_, i) => (i % 2 ? 0xff : 0)),
        '00ff00ff-00ff-40ff-80ff-00ff00ff00ff',
      ],
    ];
    for (const [bytes, expected] of cases) {
      setCrypto(
        {
          getRandomValues: (array: Uint8Array) => {
            array.set(bytes);
            return array;
          },
        },
        true,
      );
      expect(makeUuid()).toBe(expected);
      restoreCrypto();
    }
  });

  it('Math.random fallback with out-of-contract returns still yields a well-formed v4 uuid', () => {
    setCrypto(undefined, false);
    for (const v of [1, 1.5, -0.5, NaN, Infinity, -Infinity, 256.5, 2 ** 40]) {
      Math.random = () => v;
      expect(makeUuid()).toMatch(UUID_V4);
    }
    restoreCrypto();
  });

  it('a throwing or non-callable getRandomValues propagates (documented platform-contract class)', () => {
    setCrypto(
      {
        getRandomValues: () => {
          throw new Error('QuotaExceededError');
        },
      },
      true,
    );
    expect(() => makeUuid()).toThrow('QuotaExceededError');
    restoreCrypto();
    setCrypto({ getRandomValues: 1 }, true);
    expect(() => makeUuid()).toThrow(TypeError);
    restoreCrypto();
  });
});
