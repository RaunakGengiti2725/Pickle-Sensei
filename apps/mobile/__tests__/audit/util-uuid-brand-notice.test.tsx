/**
 * Execution audit — `makeUuid` randomness fallback and the imperative
 * `BrandNotice` host (notice raised before/after the host mounts, dismissal,
 * accessible dialog semantics).
 */
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const SafeAreaView = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    SafeAreaView,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { makeUuid } from '../../src/util/uuid';
import { plural } from '../../src/util/plural';
import { BrandNoticeHost, showBrandNotice } from '../../src/design/BrandNotice';

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('makeUuid', () => {
  it('produces RFC-4122 v4 ids through crypto.getRandomValues', () => {
    const cryptoObj = (globalThis as { crypto?: unknown }).crypto;
    expect(cryptoObj).toBeDefined();
    const ids = new Set(Array.from({ length: 200 }, () => makeUuid()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(V4);
  });

  it('falls back to Math.random when crypto is unavailable and still yields well-formed unique v4 ids', () => {
    const g = globalThis as { crypto?: unknown };
    const original = g.crypto;
    Object.defineProperty(g, 'crypto', {
      value: undefined,
      configurable: true,
    });
    try {
      const ids = new Set(Array.from({ length: 200 }, () => makeUuid()));
      expect(ids.size).toBe(200);
      for (const id of ids) expect(id).toMatch(V4);
    } finally {
      Object.defineProperty(g, 'crypto', {
        value: original,
        configurable: true,
      });
    }
  });
});

describe('plural', () => {
  it('handles 0 / 1 / many / negative / non-integer counts', () => {
    expect(plural(0, 'day')).toBe('days');
    expect(plural(1, 'day')).toBe('day');
    expect(plural(2, 'day')).toBe('days');
    expect(plural(-1, 'day')).toBe('days');
    expect(plural(1.5, 'day')).toBe('days');
  });
});

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(t => React.Children.toArray(t.props.children).join(''));
}

function hostPressables(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && typeof node.props.onClick === 'function',
  );
}

describe('BrandNoticeHost', () => {
  it('a notice raised before the host mounts is shown on mount, then dismissed by its action', () => {
    showBrandNotice({
      title: 'Video unavailable',
      detail: 'Try again later.',
      tone: 'danger',
      eyebrow: 'COACHING VIDEO',
    });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<BrandNoticeHost />);
    });
    const shown = texts(renderer);
    expect(shown).toEqual(
      expect.arrayContaining([
        'Video unavailable',
        'Try again later.',
        'COACHING VIDEO',
        'Got it',
      ]),
    );
    const action = hostPressables(renderer).find(
      n => n.props.accessibilityLabel === 'Got it',
    );
    expect(action).toBeDefined();
    act(() => action!.props.onClick());
    expect(texts(renderer)).not.toContain('Video unavailable');
    act(() => renderer.unmount());
  });

  it('a notice raised while the host is mounted appears immediately with its custom action label', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<BrandNoticeHost />);
    });
    expect(texts(renderer)).not.toContain('Account removed');
    act(() => {
      showBrandNotice({
        title: 'Account removed',
        detail: 'Local data was kept.',
        actionLabel: 'Continue',
      });
    });
    expect(texts(renderer)).toEqual(
      expect.arrayContaining(['Account removed', 'Continue']),
    );
    const action = hostPressables(renderer).find(
      n => n.props.accessibilityLabel === 'Continue',
    );
    expect(action).toBeDefined();
    act(() => renderer.unmount());
  });

  it('after the host unmounts a new notice is parked for the next host', () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<BrandNoticeHost />);
    });
    act(() => renderer.unmount());
    showBrandNotice({ title: 'Parked', detail: 'Shown later.' });
    act(() => {
      renderer = TestRenderer.create(<BrandNoticeHost />);
    });
    expect(texts(renderer)).toContain('Parked');
    act(() => renderer.unmount());
  });
});
