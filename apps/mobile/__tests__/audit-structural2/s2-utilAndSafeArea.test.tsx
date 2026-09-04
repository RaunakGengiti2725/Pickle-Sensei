/**
 * Structural audit #2: util/uuid (v4 shape on both randomness paths) and
 * design/safeArea (fallback inset composition).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { makeUuid } from '../../src/util/uuid';
import { plural } from '../../src/util/plural';

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('makeUuid', () => {
  it('produces RFC-4122 v4 ids with crypto randomness (verified invariant)', () => {
    const cryptoObj = (globalThis as { crypto?: { getRandomValues?: unknown } })
      .crypto;
    expect(typeof cryptoObj?.getRandomValues).toBe('function');
    const ids = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = makeUuid();
      expect(id).toMatch(V4);
      ids.add(id);
    }
    expect(ids.size).toBe(2000);
  });

  it('keeps v4 version/variant bits and uniqueness on the Math.random fallback (verified invariant)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });
    try {
      const ids = new Set<string>();
      for (let i = 0; i < 2000; i++) {
        const id = makeUuid();
        expect(id).toMatch(V4);
        ids.add(id);
      }
      expect(ids.size).toBe(2000);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });
});

describe('plural', () => {
  it('singular only for exactly 1; irregular honoured; 0/negative/fractional plural (verified invariant)', () => {
    expect(plural(1, 'day')).toBe('day');
    expect(plural(0, 'day')).toBe('days');
    expect(plural(2, 'day')).toBe('days');
    expect(plural(-1, 'day')).toBe('days');
    expect(plural(1.5, 'day')).toBe('days');
    expect(plural(3, 'rally', 'rallies')).toBe('rallies');
    expect(plural(1, 'rally', 'rallies')).toBe('rally');
  });
});

describe('useReliableSafeAreaInsets', () => {
  const insetsMock = { top: 0, bottom: 0, left: 0, right: 0 };
  let metrics: { insets: { top: number; bottom: number } } | null = null;

  jest.doMock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => insetsMock,
    get initialWindowMetrics() {
      return metrics;
    },
  }));

  function Probe() {
    const { useReliableSafeAreaInsets } =
      require('../../src/design/safeArea') as typeof import('../../src/design/safeArea');
    const insets = useReliableSafeAreaInsets();
    return <Text>{`${insets.top}/${insets.bottom}`}</Text>;
  }

  function read(): string {
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(<Probe />);
    });
    const value = String(root.root.findByType(Text).props.children);
    act(() => root.unmount());
    return value;
  }

  it('prefers the larger of live insets and launch metrics (verified invariant)', () => {
    metrics = { insets: { top: 59, bottom: 34 } };
    insetsMock.top = 0;
    insetsMock.bottom = 0;
    expect(read()).toBe('59/34');
    insetsMock.top = 62;
    insetsMock.bottom = 40;
    expect(read()).toBe('62/40');
  });

  it('falls back to the iOS 44/34 constants only when launch metrics are absent (verified invariant)', () => {
    metrics = null;
    insetsMock.top = 0;
    insetsMock.bottom = 0;
    expect(read()).toBe('44/34');
    insetsMock.top = 20;
    insetsMock.bottom = 0;
    expect(read()).toBe('44/34');
  });
});
