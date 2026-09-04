/**
 * AUDIT — src/util: makeUuid had zero tests (format, RFC 4122 v4 version/
 * variant bits, the Math.random fallback, collision over a large sample);
 * plural edge inputs (0, negatives, fractions, NaN) were not pinned.
 */
import { makeUuid } from '../../src/util/uuid';
import { plural } from '../../src/util/plural';

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('makeUuid', () => {
  it('VERIFIED: with crypto.getRandomValues → lowercase RFC 4122 v4 layout, unique across 20k draws', () => {
    const cryptoObj = (globalThis as { crypto?: { getRandomValues?: unknown } })
      .crypto;
    expect(typeof cryptoObj?.getRandomValues).toBe('function');
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      const id = makeUuid();
      expect(id).toMatch(V4);
      seen.add(id);
    }
    expect(seen.size).toBe(20_000);
  });

  it('VERIFIED: without crypto the Math.random fallback still produces well-formed v4 ids and distinct values', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 5_000; i++) {
        const id = makeUuid();
        expect(id).toMatch(V4);
        seen.add(id);
      }
      expect(seen.size).toBe(5_000);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  it('VERIFIED: version/variant nibbles are forced even when the RNG returns all-zero or all-0xff bytes', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const fill = (byte: number) => ({
      getRandomValues: (arr: Uint8Array) => {
        arr.fill(byte);
        return arr;
      },
    });
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: fill(0x00),
        configurable: true,
        writable: true,
      });
      expect(makeUuid()).toBe('00000000-0000-4000-8000-000000000000');
      Object.defineProperty(globalThis, 'crypto', {
        value: fill(0xff),
        configurable: true,
        writable: true,
      });
      expect(makeUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });
});

describe('plural', () => {
  it('VERIFIED: only exactly 1 is singular — 0, -1, 1.5, NaN and 2 all take the plural form', () => {
    expect(plural(1, 'day')).toBe('day');
    expect(plural(0, 'day')).toBe('days');
    expect(plural(-1, 'day')).toBe('days');
    expect(plural(1.5, 'day')).toBe('days');
    expect(plural(Number.NaN, 'day')).toBe('days');
    expect(plural(2, 'rally', 'rallies')).toBe('rallies');
    expect(plural(1, 'rally', 'rallies')).toBe('rally');
  });
});
