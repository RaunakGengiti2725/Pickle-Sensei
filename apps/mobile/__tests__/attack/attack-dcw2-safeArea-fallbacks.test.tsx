/**
 * ADVERSARIAL PASS 3 (tester #2) — mobile-design-components-walkthrough — S6.
 *
 * `useReliableSafeAreaInsets` (src/design/safeArea.ts) papers over the iOS
 * full-screen-modal quirk where `useSafeAreaInsets()` briefly reports 0/0:
 *   top    = max(insets.top,    initialWindowMetrics?.insets.top    ?? (ios ? 44 : StatusBar.currentHeight ?? 0))
 *   bottom = max(insets.bottom, initialWindowMetrics?.insets.bottom ?? (ios ? 34 : 0))
 *
 * The safe-area module is mocked with LIVE getters so `initialWindowMetrics`
 * and the hook result can be varied per case without re-importing;
 * `Platform.OS` is swapped with `Object.defineProperty` (the pattern already
 * used in __tests__/wf/SettingsScreen.buttons.test.tsx) and
 * `StatusBar.currentHeight` is assigned directly (it is a static field that
 * the jest iOS preset leaves `null`).
 *
 * Attacks beyond the assigned pair: metrics present but zero (must WIN over
 * the fallback — that is the contract), negative / NaN / Infinity insets,
 * huge insets, a mid-render platform flip, and 200 re-renders for stability.
 */
import React from 'react';
import { Platform, StatusBar, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const state: {
  insets: { top: number; bottom: number; left: number; right: number };
  metrics: {
    insets: { top: number; bottom: number; left: number; right: number };
    frame: { x: number; y: number; width: number; height: number };
  } | null;
} = {
  insets: { top: 0, bottom: 0, left: 0, right: 0 },
  metrics: null,
};

jest.mock('react-native-safe-area-context', () => ({
  get initialWindowMetrics() {
    return state.metrics;
  },
  useSafeAreaInsets: () => state.insets,
}));

import { useReliableSafeAreaInsets } from '../../src/design/safeArea';

function setOS(os: string) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

const originalOS = Platform.OS;
const originalStatusBarHeight = StatusBar.currentHeight;

afterEach(() => {
  setOS(originalOS);
  StatusBar.currentHeight = originalStatusBarHeight;
  state.insets = { top: 0, bottom: 0, left: 0, right: 0 };
  state.metrics = null;
});

let latest: { top: number; bottom: number } | null = null;
let renders = 0;

function Probe() {
  latest = useReliableSafeAreaInsets();
  renders += 1;
  return <View />;
}

function readInsets(): { top: number; bottom: number } {
  latest = null;
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<Probe />);
  });
  act(() => renderer.unmount());
  expect(latest).not.toBeNull();
  return latest!;
}

describe('ATTACK S6 — useReliableSafeAreaInsets fallbacks with zero insets and null initialWindowMetrics', () => {
  it('precondition: jest preset is iOS with StatusBar.currentHeight null', () => {
    expect(originalOS).toBe('ios');
    expect(originalStatusBarHeight).toBeNull();
  });

  it('iOS: {0,0} + null metrics → 44 / 34', () => {
    setOS('ios');
    expect(readInsets()).toEqual({ top: 44, bottom: 34 });
  });

  it('Android: {0,0} + null metrics + currentHeight null → 0 / 0', () => {
    setOS('android');
    StatusBar.currentHeight = null;
    expect(readInsets()).toEqual({ top: 0, bottom: 0 });
  });

  it('Android: {0,0} + null metrics + currentHeight 24 → 24 / 0', () => {
    setOS('android');
    StatusBar.currentHeight = 24;
    expect(readInsets()).toEqual({ top: 24, bottom: 0 });
  });

  it('Android: currentHeight undefined (older bridges) → 0 / 0', () => {
    setOS('android');
    (StatusBar as { currentHeight: number | null | undefined }).currentHeight =
      undefined;
    expect(readInsets()).toEqual({ top: 0, bottom: 0 });
  });

  it('iOS then Android in the same process (platform flip between renders)', () => {
    setOS('ios');
    expect(readInsets()).toEqual({ top: 44, bottom: 34 });
    setOS('android');
    StatusBar.currentHeight = 30;
    expect(readInsets()).toEqual({ top: 30, bottom: 0 });
    setOS('ios');
    expect(readInsets()).toEqual({ top: 44, bottom: 34 });
  });

  it('metrics present with ZERO insets must beat the hard-coded fallback (iPad / SE-class devices)', () => {
    setOS('ios');
    state.metrics = {
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
      frame: { x: 0, y: 0, width: 375, height: 667 },
    };
    expect(readInsets()).toEqual({ top: 0, bottom: 0 });
  });

  it('metrics present (59/34) with live insets 0/0 → metrics win', () => {
    setOS('ios');
    state.metrics = {
      insets: { top: 59, bottom: 34, left: 0, right: 0 },
      frame: { x: 0, y: 0, width: 393, height: 852 },
    };
    expect(readInsets()).toEqual({ top: 59, bottom: 34 });
  });

  it('live insets larger than every fallback win (landscape / dynamic island 62)', () => {
    setOS('ios');
    state.insets = { top: 62, bottom: 40, left: 0, right: 0 };
    expect(readInsets()).toEqual({ top: 62, bottom: 40 });
  });

  it('live insets BELOW the fallback are lifted (iOS 20pt legacy status bar → 44)', () => {
    setOS('ios');
    state.insets = { top: 20, bottom: 0, left: 0, right: 0 };
    expect(readInsets()).toEqual({ top: 44, bottom: 34 });
  });

  it('hostile: negative live insets are clamped up by the fallback', () => {
    setOS('ios');
    state.insets = { top: -10, bottom: -5, left: 0, right: 0 };
    expect(readInsets()).toEqual({ top: 44, bottom: 34 });
  });

  it('hostile: NaN live insets — records whether NaN leaks into layout', () => {
    setOS('ios');
    state.insets = { top: Number.NaN, bottom: Number.NaN, left: 0, right: 0 };
    const result = readInsets();
    console.log(`[ATTACK S6] NaN insets → ${JSON.stringify(result)}`);
    expect(Number.isNaN(result.top)).toBe(true);
    expect(Number.isNaN(result.bottom)).toBe(true);
  });

  it('hostile: Android StatusBar.currentHeight NaN — records whether NaN leaks', () => {
    setOS('android');
    StatusBar.currentHeight = Number.NaN;
    const result = readInsets();
    console.log(`[ATTACK S6] NaN currentHeight → ${JSON.stringify(result)}`);
    expect(Number.isNaN(result.top)).toBe(true);
    expect(result.bottom).toBe(0);
  });

  it('hostile: Infinity live insets pass through (Math.max)', () => {
    setOS('ios');
    state.insets = {
      top: Number.POSITIVE_INFINITY,
      bottom: 0,
      left: 0,
      right: 0,
    };
    const result = readInsets();
    expect(result.top).toBe(Number.POSITIVE_INFINITY);
    expect(result.bottom).toBe(34);
  });

  it('stability: 200 re-renders with alternating insets never produce a value below the fallback', () => {
    setOS('ios');
    renders = 0;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe key={0} />);
    });
    for (let i = 1; i <= 200; i++) {
      state.insets =
        i % 2
          ? { top: 0, bottom: 0, left: 0, right: 0 }
          : { top: 47, bottom: 34, left: 0, right: 0 };
      act(() => {
        renderer.update(<Probe key={i} />);
      });
      expect(latest!.top).toBeGreaterThanOrEqual(44);
      expect(latest!.bottom).toBeGreaterThanOrEqual(34);
    }
    expect(renders).toBe(201);
    act(() => renderer.unmount());
  });
});
