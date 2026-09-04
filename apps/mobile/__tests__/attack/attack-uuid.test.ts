/**
 * ADVERSARIAL PASS 3 — scenario 1 (mobile-design-components-walkthrough).
 *
 * Attack: makeUuid() with `globalThis.crypto` deleted (Math.random fallback)
 * and with `getRandomValues` present. 10,000 ids per mode must all be
 * RFC-4122 v4 (version nibble 4, variant nibble [89ab]) and mutually unique.
 * Math.random is replaced by a seeded mulberry32 stream so the fallback run
 * is reproducible (seed recorded below); the crypto run uses Node's real CSPRNG.
 */
import { makeUuid } from '../../src/util/uuid';

const N = 10_000;
const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Seed used for the Math.random fallback run (mulberry32). */
export const FALLBACK_SEED = 0x5eed1234;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertBatch(ids: string[]) {
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const id of ids) {
    if (!V4.test(id)) bad.push(id);
    seen.add(id);
  }
  expect(bad).toEqual([]);
  expect(seen.size).toBe(ids.length);
  // Explicit nibble checks in addition to the regex (belt and braces).
  for (const id of ids) {
    expect(id.length).toBe(36);
    expect(id[14]).toBe('4');
    expect('89ab').toContain(id[19]!);
  }
}

describe('makeUuid adversarial', () => {
  const originalCrypto = (globalThis as { crypto?: unknown }).crypto;
  const originalRandom = Math.random;

  afterEach(() => {
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
      writable: true,
    });
    Math.random = originalRandom;
  });

  it(`10,000 ids with globalThis.crypto deleted are unique RFC-4122 v4 (seed ${FALLBACK_SEED})`, () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete (globalThis as { crypto?: unknown }).crypto;
    expect((globalThis as { crypto?: unknown }).crypto).toBeUndefined();
    Math.random = mulberry32(FALLBACK_SEED);

    const ids: string[] = [];
    for (let i = 0; i < N; i += 1) ids.push(makeUuid());
    assertBatch(ids);
  });

  it('10,000 ids with crypto.getRandomValues present are unique RFC-4122 v4 and never touch Math.random', () => {
    expect(
      typeof (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto
        ?.getRandomValues,
    ).toBe('function');
    const randomSpy = jest.fn(() => {
      throw new Error('Math.random must not be consulted when crypto exists');
    });
    Math.random = randomSpy as unknown as () => number;

    const ids: string[] = [];
    for (let i = 0; i < N; i += 1) ids.push(makeUuid());
    assertBatch(ids);
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('a crypto object WITHOUT getRandomValues falls back instead of throwing', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
      writable: true,
    });
    Math.random = mulberry32(FALLBACK_SEED ^ 0xffff);
    const ids: string[] = [];
    for (let i = 0; i < 1_000; i += 1) ids.push(makeUuid());
    assertBatch(ids);
  });

  it('Math.random returning exactly 0 or 1-ε still yields well-formed v4 ids', () => {
    delete (globalThis as { crypto?: unknown }).crypto;
    Math.random = () => 0;
    const zero = makeUuid();
    expect(zero).toBe('00000000-0000-4000-8000-000000000000');
    Math.random = () => 1 - Number.EPSILON;
    const max = makeUuid();
    expect(max).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(V4.test(zero)).toBe(true);
    expect(V4.test(max)).toBe(true);
  });

  it('a getRandomValues that fills nothing still produces a syntactically valid v4 id', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (a: Uint8Array) => a },
      configurable: true,
      writable: true,
    });
    const id = makeUuid();
    expect(id).toBe('00000000-0000-4000-8000-000000000000');
    expect(V4.test(id)).toBe(true);
  });
});
