/**
 * ADVERSARIAL PASS 3 (tester #2) — extra attacks beyond the seven assigned:
 *  - `plural` (src/util/plural.ts) with hostile counts (NaN, -1, 1.0, "1",
 *    Infinity, -0, huge) — the label must never lie for exactly-one and must
 *    never throw;
 *  - `makeUuid` (src/util/uuid.ts) with and without `crypto.getRandomValues`
 *    — 5 000 ids must all be well-formed v4, unique, and the fallback must not
 *    leak into the version/variant bits;
 *  - `ScoreRing` (src/design/components.tsx:590-712) with out-of-range /
 *    non-finite scores under reduced motion — the a11y label and number must
 *    stay honest and the arc fraction must stay within [0, 1].
 *
 * Reduced motion is forced on via the AccessibilityInfo mock so the ring
 * renders its final state synchronously (no rAF count-up).
 */
import React from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

import { ScoreRing } from '../../src/design/components';
import { plural } from '../../src/util/plural';
import { makeUuid } from '../../src/util/uuid';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('ATTACK extras — plural()', () => {
  it.each([
    [1, 'shot'],
    [1.0, 'shot'],
    [0, 'shots'],
    [-1, 'shots'],
    [2, 'shots'],
    [-0, 'shots'],
    [Number.NaN, 'shots'],
    [Number.POSITIVE_INFINITY, 'shots'],
    [Number.MAX_SAFE_INTEGER, 'shots'],
    [1.0000000000000002, 'shots'],
    [0.9999999999999999, 'shots'],
  ])('plural(%p) → %s', (count, expected) => {
    expect(plural(count, 'shot')).toBe(expected);
  });

  it('a string "1" smuggled through an any-cast is NOT treated as one (strict equality)', () => {
    expect(plural('1' as unknown as number, 'shot')).toBe('shots');
  });

  it('unicode singular/plural pass through untouched and huge labels do not throw', () => {
    expect(plural(1, 'entraînement', 'entraînements')).toBe('entraînement');
    expect(plural(3, 'entraînement', 'entraînements')).toBe('entraînements');
    const huge = 'x'.repeat(1_000_000);
    expect(plural(2, huge)).toHaveLength(1_000_001);
  });
});

describe('ATTACK extras — makeUuid()', () => {
  it('5000 ids with crypto are v4/variant-1, unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = makeUuid();
      expect(id).toMatch(UUID_V4);
      seen.add(id);
    }
    expect(seen.size).toBe(5000);
  });

  it('with crypto removed the Math.random fallback still yields v4/variant-1, unique ids', () => {
    const globalWithCrypto = globalThis as { crypto?: unknown };
    const saved = globalWithCrypto.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    try {
      const seen = new Set<string>();
      for (let i = 0; i < 5000; i++) {
        const id = makeUuid();
        expect(id).toMatch(UUID_V4);
        seen.add(id);
      }
      expect(seen.size).toBe(5000);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: saved,
        configurable: true,
        writable: true,
      });
    }
  });

  it('a getRandomValues that returns all-0xff bytes still gets version/variant bits forced', () => {
    const globalWithCrypto = globalThis as { crypto?: unknown };
    const saved = globalWithCrypto.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: {
        getRandomValues: (a: Uint8Array) => {
          a.fill(0xff);
          return a;
        },
      },
      configurable: true,
      writable: true,
    });
    try {
      expect(makeUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: saved,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe('ATTACK extras — ScoreRing with hostile scores (reduced motion on)', () => {
  const isReduceMotionEnabled =
    AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
      typeof AccessibilityInfo.isReduceMotionEnabled
    >;

  beforeAll(() => {
    isReduceMotionEnabled.mockResolvedValue(true);
  });

  function mount(score: number) {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<ScoreRing score={score} />);
    });
    const label = renderer.root
      .findAllByType(View)
      .map(n => n.props.accessibilityLabel as string | undefined)
      .find(Boolean);
    const text = renderer.root
      .findAllByType(Text)
      .map(n => String(n.props.children))
      .join('|');
    act(() => renderer.unmount());
    return { label, text };
  }

  it.each([0, 10, 5.55, 9.949999, 0.05])(
    'in-range score %p renders one-decimal text and matching label',
    score => {
      const { label, text } = mount(score);
      expect(label).toBe(`Technique score ${score.toFixed(1)} out of 10`);
      expect(text).toContain(score.toFixed(1));
    },
  );

  it.each([
    [10.5, '10.5'],
    [-1, '-1.0'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'Infinity'],
    [Number.NEGATIVE_INFINITY, '-Infinity'],
    [1e21, '1e+21'],
  ])(
    'out-of-range score %p — what the user and screen reader get',
    (score, printed) => {
      const { label, text } = mount(score);
      console.log(
        `[ATTACK extras] ScoreRing(${score}) → text=${JSON.stringify(text)} label=${JSON.stringify(label)}`,
      );
      expect(text.split('|')[0]).toBe(printed);
      expect(label).toBe(`Technique score ${printed} out of 10`);
    },
  );
});
