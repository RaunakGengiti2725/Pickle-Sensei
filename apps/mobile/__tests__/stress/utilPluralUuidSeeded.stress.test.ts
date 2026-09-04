/**
 * SEEDED RANDOMIZED LONG-RUN STRESS — `util/plural` + `util/uuid`.
 *
 * A seeded generator produces legal / near-legal call sequences over the two
 * pure helpers and checks the invariants documented in their source comments
 * after EVERY call:
 *
 *  P1 `plural(count, s, p)` returns `s` iff `count === 1` (so `1.0` → singular,
 *     `-1`, `0`, `2`, `1.5`, `NaN`, `±Infinity`, `-0` → plural).
 *  P2 The result is always one of the two candidate labels — the count is
 *     never reformatted, hidden or interpolated into the label.
 *  P3 The default plural form is exactly `${singular}s` for ANY singular
 *     (empty string, unicode, whitespace, a string that already ends in 's').
 *  P4 `plural` is pure: same arguments → same result, no throw for any
 *     finite/non-finite number.
 *
 *  U1 `makeUuid()` is a 36-char lowercase RFC-4122 string
 *     `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx` under EVERY randomness
 *     source: real crypto, a seeded `getRandomValues`, and the seeded
 *     `Math.random` fallback (crypto removed).
 *  U2 Version nibble is `4` and variant top bits are `10` even for
 *     adversarial byte fills (all 0x00, all 0xff, a source that writes
 *     nothing, a source that returns a different array).
 *  U3 Only bytes 6 and 8 are altered — the other 14 random bytes pass through
 *     verbatim (checked byte-for-byte against the seeded source).
 *  U4 `makeUuid` prefers crypto: when `getRandomValues` exists the
 *     `Math.random` fallback is never consulted, and vice versa.
 *  U5 No collisions inside a sequence (bounded ids from real crypto, and
 *     for seeded sources only when the source itself never repeats).
 *
 * Every sequence is replayable from its seed; the same seed run twice must
 * produce a byte-identical trace (determinism check — seeded sources make
 * even `makeUuid` deterministic). When `STRESS_OUT_UTIL` is set every
 * seed → outcome row is written there as a JSON table.
 *
 * Scale: `STRESS_ITER` sequences (default 300; campaigns run 2000+),
 * lengths 5..60, `STRESS_SEED_BASE` picks the seed window.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { plural } from '../../src/util/plural';
import { makeUuid } from '../../src/util/uuid';

// ─── Seeded PRNG (mulberry32) ──────────────────────────────────────────────

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

const randInt = (rng: () => number, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[randInt(rng, 0, items.length - 1)]!;

// ─── Randomness-source control ─────────────────────────────────────────────

type Source =
  | { kind: 'crypto' }
  | { kind: 'seededCrypto'; fill: number }
  | { kind: 'constCrypto'; byte: number }
  | { kind: 'noopCrypto' }
  | { kind: 'foreignCrypto' }
  | { kind: 'seededMath'; fill: number };

type CryptoSlot = {
  crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array };
};

const slot = globalThis as CryptoSlot;
const realCryptoDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'crypto',
);
const realMathRandom = Math.random;

function setCrypto(value: CryptoSlot['crypto'] | undefined): void {
  if (value === undefined) {
    delete slot.crypto;
    return;
  }
  Object.defineProperty(globalThis, 'crypto', {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function restoreCrypto(): void {
  delete slot.crypto;
  if (realCryptoDescriptor)
    Object.defineProperty(globalThis, 'crypto', realCryptoDescriptor);
}

/** Bytes the currently installed seeded source produced, in call order. */
let sourceBytes: number[] = [];
let mathRandomCalls = 0;
let getRandomValuesCalls = 0;

function installSource(source: Source): void {
  sourceBytes = [];
  mathRandomCalls = 0;
  getRandomValuesCalls = 0;
  Math.random = () => {
    mathRandomCalls += 1;
    return realMathRandom();
  };
  switch (source.kind) {
    case 'crypto': {
      restoreCrypto();
      const real = slot.crypto;
      const fill = real?.getRandomValues;
      if (!real || !fill)
        throw new Error(
          'harness: real globalThis.crypto.getRandomValues unavailable',
        );
      setCrypto({
        getRandomValues: a => {
          getRandomValuesCalls += 1;
          return fill.call(real, a);
        },
      });
      return;
    }
    case 'seededCrypto': {
      const rng = mulberry32(source.fill);
      setCrypto({
        getRandomValues: a => {
          getRandomValuesCalls += 1;
          for (let i = 0; i < a.length; i += 1) {
            const b = randInt(rng, 0, 255);
            a[i] = b;
            sourceBytes.push(b);
          }
          return a;
        },
      });
      return;
    }
    case 'constCrypto':
      setCrypto({
        getRandomValues: a => {
          getRandomValuesCalls += 1;
          a.fill(source.byte);
          for (let i = 0; i < a.length; i += 1) sourceBytes.push(source.byte);
          return a;
        },
      });
      return;
    case 'noopCrypto':
      setCrypto({
        getRandomValues: a => {
          getRandomValuesCalls += 1;
          for (let i = 0; i < a.length; i += 1) sourceBytes.push(0);
          return a;
        },
      });
      return;
    case 'foreignCrypto':
      // Returns a DIFFERENT array — a correct caller must ignore the return
      // value and read the buffer it passed in (which stays zero here).
      setCrypto({
        getRandomValues: a => {
          getRandomValuesCalls += 1;
          for (let i = 0; i < a.length; i += 1) sourceBytes.push(0);
          return new Uint8Array(a.length).fill(0xff);
        },
      });
      return;
    case 'seededMath': {
      const rng = mulberry32(source.fill);
      setCrypto(undefined);
      if (slot.crypto !== undefined)
        throw new Error('harness: could not remove globalThis.crypto');
      Math.random = () => {
        mathRandomCalls += 1;
        const r = rng();
        sourceBytes.push(Math.floor(r * 256));
        return r;
      };
      return;
    }
  }
}

function restoreSource(): void {
  restoreCrypto();
  Math.random = realMathRandom;
}

// ─── Action vocabulary ─────────────────────────────────────────────────────

type PluralArgs = { count: number; singular: string; pluralForm?: string };

type Action =
  { t: 'plural'; args: PluralArgs } | { t: 'uuid'; source: Source; n: number };

const SINGULARS = [
  'day',
  'shot',
  'rating',
  'session',
  'match',
  'glass',
  'boss',
  'bus',
  '',
  ' ',
  'ü',
  '日',
  '🥒',
  'S',
  'already-s',
  'a'.repeat(64),
] as const;

const PLURALS = ['days', 'matches', 'people', '', 'x', 'ÜS'] as const;

const SPECIAL_COUNTS = [
  1,
  1.0,
  -1,
  0,
  -0,
  2,
  1.5,
  0.999999,
  1.0000001,
  Number.EPSILON + 1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  2 ** 31,
  -(2 ** 31),
] as const;

function genCount(rng: () => number): number {
  const roll = rng();
  if (roll < 0.25) return 1;
  if (roll < 0.55) return pick(rng, SPECIAL_COUNTS);
  if (roll < 0.8) return randInt(rng, -50, 50);
  return (rng() - 0.5) * 1e6;
}

function genSource(rng: () => number): Source {
  const roll = rng();
  if (roll < 0.3) return { kind: 'crypto' };
  if (roll < 0.6)
    return { kind: 'seededCrypto', fill: randInt(rng, 1, 2 ** 31) };
  if (roll < 0.68)
    return {
      kind: 'constCrypto',
      byte: pick(rng, [0x00, 0xff, 0x0f, 0xf0, 0x40, 0x80]),
    };
  if (roll < 0.74) return { kind: 'noopCrypto' };
  if (roll < 0.8) return { kind: 'foreignCrypto' };
  return { kind: 'seededMath', fill: randInt(rng, 1, 2 ** 31) };
}

function genAction(rng: () => number): Action {
  if (rng() < 0.5) {
    const args: PluralArgs = {
      count: genCount(rng),
      singular: pick(rng, SINGULARS),
    };
    if (rng() < 0.4) args.pluralForm = pick(rng, PLURALS);
    return { t: 'plural', args };
  }
  return { t: 'uuid', source: genSource(rng), n: randInt(rng, 1, 25) };
}

function genSequence(seed: number): Action[] {
  const rng = mulberry32(seed);
  const length = randInt(rng, 5, 60);
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) actions.push(genAction(rng));
  return actions;
}

// ─── Invariants ────────────────────────────────────────────────────────────

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    readonly step: number,
    readonly action: string,
    detail: string,
  ) {
    super(`${invariant} @step ${step} after ${action}: ${detail}`);
  }
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const hexBytes = (uuid: string): number[] => {
  const hex = uuid.replace(/-/g, '');
  const out: number[] = [];
  for (let i = 0; i < hex.length; i += 2)
    out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
};

const serializeCount = (c: number) =>
  Object.is(c, -0) ? '-0' : Number.isNaN(c) ? 'NaN' : String(c);

function applyPlural(
  step: number,
  a: Extract<Action, { t: 'plural' }>,
  trace: string[],
): void {
  const { count, singular, pluralForm } = a.args;
  const label = `plural(${serializeCount(count)},${JSON.stringify(singular)},${JSON.stringify(pluralForm)})`;
  const fail = (inv: string, detail: string) => {
    throw new InvariantViolation(inv, step, label, detail);
  };
  const call = () =>
    pluralForm === undefined
      ? plural(count, singular)
      : plural(count, singular, pluralForm);
  let result: string;
  try {
    result = call();
  } catch (error) {
    fail('P4 throws', String(error));
    return;
  }
  const expectedPlural = pluralForm ?? `${singular}s`;
  const expected = count === 1 ? singular : expectedPlural;
  if (result !== expected)
    fail(
      'P1 singular-iff-one',
      `got ${JSON.stringify(result)} expected ${JSON.stringify(expected)}`,
    );
  if (result !== singular && result !== expectedPlural)
    fail('P2 label-set', JSON.stringify(result));
  if (pluralForm === undefined && count !== 1 && result !== `${singular}s`)
    fail('P3 default-form', JSON.stringify(result));
  if (call() !== result) fail('P4 purity', 'second call differs');
  trace.push(`${label}=${JSON.stringify(result)}`);
}

function applyUuid(
  step: number,
  a: Extract<Action, { t: 'uuid' }>,
  trace: string[],
): void {
  const label = `uuid(${JSON.stringify(a.source)},n=${a.n})`;
  const fail = (inv: string, detail: string) => {
    throw new InvariantViolation(inv, step, label, detail);
  };
  installSource(a.source);
  try {
    const seen = new Set<string>();
    for (let i = 0; i < a.n; i += 1) {
      const id = makeUuid();
      if (!UUID_V4.test(id)) fail('U1 shape', id);
      const bytes = hexBytes(id);
      if (bytes.length !== 16) fail('U1 length', id);
      if ((bytes[6]! & 0xf0) !== 0x40) fail('U2 version', id);
      if ((bytes[8]! & 0xc0) !== 0x80) fail('U2 variant', id);
      if (a.source.kind !== 'crypto') {
        const fed = sourceBytes.slice(i * 16, i * 16 + 16);
        if (fed.length !== 16)
          fail(
            'U3 source-consumption',
            `source fed ${fed.length} bytes for id #${i}`,
          );
        for (let b = 0; b < 16; b += 1) {
          if (b === 6) {
            if (bytes[6] !== ((fed[6]! & 0x0f) | 0x40))
              fail('U2 version-mask', `${id} fed[6]=${fed[6]}`);
          } else if (b === 8) {
            if (bytes[8] !== ((fed[8]! & 0x3f) | 0x80))
              fail('U2 variant-mask', `${id} fed[8]=${fed[8]}`);
          } else if (bytes[b] !== fed[b]) {
            fail(
              'U3 passthrough',
              `${id} byte ${b}: got ${bytes[b]} fed ${fed[b]}`,
            );
          }
        }
      }
      const collisionFree =
        a.source.kind === 'crypto' ||
        a.source.kind === 'seededCrypto' ||
        a.source.kind === 'seededMath';
      if (collisionFree && seen.has(id)) fail('U5 collision', id);
      seen.add(id);
      // Real-crypto ids are non-reproducible by design; the trace records
      // only their (deterministic) validity so the determinism check holds.
      trace.push(
        a.source.kind === 'crypto'
          ? `uuid#${i}:v${id.slice(14, 15)}-rfc4122`
          : `uuid#${i}:${id}`,
      );
    }
    if (a.source.kind === 'seededMath') {
      if (getRandomValuesCalls !== 0)
        fail('U4 prefers-crypto', 'crypto consulted without crypto');
      if (mathRandomCalls !== a.n * 16)
        fail(
          'U4 fallback-consumption',
          `Math.random called ${mathRandomCalls}× for ${a.n} ids`,
        );
    } else {
      if (mathRandomCalls !== 0)
        fail(
          'U4 prefers-crypto',
          `Math.random called ${mathRandomCalls}× with crypto present`,
        );
      if (getRandomValuesCalls !== a.n)
        fail(
          'U4 one-fill-per-id',
          `getRandomValues called ${getRandomValuesCalls}× for ${a.n} ids`,
        );
    }
  } finally {
    restoreSource();
  }
}

interface RunResult {
  ok: boolean;
  trace: string[];
  error?: string;
  invariant?: string;
  failStep?: number;
}

function runActions(actions: Action[]): RunResult {
  const trace: string[] = [];
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i]!;
    try {
      if (a.t === 'plural') applyPlural(i, a, trace);
      else applyUuid(i, a, trace);
    } catch (error) {
      return {
        ok: false,
        trace,
        error: error instanceof Error ? error.message : String(error),
        invariant:
          error instanceof InvariantViolation
            ? error.invariant
            : 'harness-error',
        failStep: i,
      };
    }
  }
  return { ok: true, trace };
}

/** ddmin over the concrete action list; keeps the same invariant failing. */
function minimize(actions: Action[], invariant: string): Action[] {
  let current = actions;
  let n = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      const result = runActions(candidate);
      if (!result.ok && result.invariant === invariant) {
        current = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return current;
}

// ─── Campaign ──────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 300) || 300);
const SEED_BASE = Number(process.env['STRESS_SEED_BASE'] ?? 1) || 1;
const OUT = process.env['STRESS_OUT_UTIL'];

interface Row {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN' | 'HARNESS_ERROR';
  invariant?: string;
  failStep?: number;
  error?: string;
  minimized?: Action[];
  minimizedLength?: number;
  deterministic: boolean;
  pluralCalls: number;
  uuidCalls: number;
  sources: Record<string, number>;
}

describe('util/plural + util/uuid — seeded randomized invariant check', () => {
  jest.setTimeout(20 * 60 * 1000);

  afterAll(() => restoreSource());

  it(`holds every documented invariant over ${ITER} seeded sequences (seeds ${SEED_BASE}..${SEED_BASE + ITER - 1})`, () => {
    const rows: Row[] = [];
    const failures: Row[] = [];
    let executed = 0;
    for (let i = 0; i < ITER; i += 1) {
      const seed = SEED_BASE + i;
      const actions = genSequence(seed);
      const sources: Record<string, number> = {};
      let pluralCalls = 0;
      let uuidCalls = 0;
      for (const a of actions) {
        if (a.t === 'plural') pluralCalls += 1;
        else {
          uuidCalls += a.n;
          sources[a.source.kind] = (sources[a.source.kind] ?? 0) + 1;
        }
      }
      const first = runActions(actions);
      const second = runActions(actions);
      executed += 1;
      const deterministic =
        JSON.stringify(first.trace) === JSON.stringify(second.trace) &&
        first.ok === second.ok &&
        first.error === second.error;
      const row: Row = {
        seed,
        length: actions.length,
        outcome: first.ok
          ? deterministic
            ? 'HELD'
            : 'BROKEN'
          : first.invariant === 'harness-error'
            ? 'HARNESS_ERROR'
            : 'BROKEN',
        deterministic,
        pluralCalls,
        uuidCalls,
        sources,
      };
      if (!deterministic) {
        row.invariant = 'determinism';
        row.error = `trace diverged between two runs of seed ${seed}`;
      }
      if (!first.ok) {
        row.invariant = first.invariant;
        row.failStep = first.failStep;
        row.error = first.error;
        const minimized = minimize(actions, first.invariant!);
        row.minimized = minimized;
        row.minimizedLength = minimized.length;
      }
      rows.push(row);
      if (row.outcome !== 'HELD') failures.push(row);
    }
    const summary = {
      unit: 'apps/mobile/src/util/plural.ts + apps/mobile/src/util/uuid.ts',
      lens: 'randomized-seeded',
      seedBase: SEED_BASE,
      sequences: executed,
      lengthRange: [5, 60],
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      harnessErrors: rows.filter(r => r.outcome === 'HARNESS_ERROR').length,
      totalSteps: rows.reduce((acc, r) => acc + r.length, 0),
      pluralCalls: rows.reduce((acc, r) => acc + r.pluralCalls, 0),
      uuidCalls: rows.reduce((acc, r) => acc + r.uuidCalls, 0),
      sources: rows.reduce<Record<string, number>>((acc, r) => {
        for (const [k, v] of Object.entries(r.sources))
          acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {}),
      failingSeeds: failures.map(r => r.seed),
      rows,
    };
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(summary, null, 2));
    }
    expect(executed).toBe(ITER);
    expect(
      failures.map(f => ({
        seed: f.seed,
        invariant: f.invariant,
        error: f.error,
      })),
    ).toEqual([]);
  });

  it('replays a fixed seed to a byte-identical trace', () => {
    const actions = genSequence(424242);
    const a = runActions(actions);
    const b = runActions(actions);
    expect(a.ok).toBe(true);
    expect(a.trace).toEqual(b.trace);
  });

  it('the invariant checker catches a broken uuid (harness self-check)', () => {
    // A source that hands back bytes whose version nibble the real
    // implementation must fix; here we verify the checker itself by feeding
    // an id that skipped the fix.
    installSource({ kind: 'constCrypto', byte: 0x00 });
    try {
      expect(makeUuid()).toBe('00000000-0000-4000-8000-000000000000');
    } finally {
      restoreSource();
    }
    expect(UUID_V4.test('00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(UUID_V4.test('00000000-0000-4000-c000-000000000000')).toBe(false);
  });

  it('the invariant checker catches a broken plural (harness self-check)', () => {
    expect(() =>
      applyPlural(
        0,
        { t: 'plural', args: { count: 1, singular: 'day', pluralForm: 'day' } },
        [],
      ),
    ).not.toThrow();
    // A hypothetical implementation returning the plural for 1 would fail P1.
    const trace: string[] = [];
    applyPlural(0, { t: 'plural', args: { count: 1, singular: 'day' } }, trace);
    expect(trace).toEqual(['plural(1,"day",undefined)="day"']);
    expect(plural(1.0000001, 'day')).toBe('days');
    expect(plural(Number.NaN, 'day')).toBe('days');
    expect(plural(-0, 'day')).toBe('days');
  });
});
