/**
 * Execution audit — the FIRST mount in a process happens before
 * `AccessibilityInfo.isReduceMotionEnabled()` has resolved.
 *
 * `useReducedMotion` (src/design/components.tsx) seeds its module-level cache
 * with `false` and only corrects it when the async probe settles. A motion
 * primitive that decides its animation at mount (ScoreRing seeds its shared
 * value and count-up state from `animate`) therefore starts moving for one
 * tick even when the OS setting is on, then snaps to rest. This file holds
 * exactly one test so the "fresh process" precondition is order-independent.
 */
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});

import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ScoreRing } from '../../src/design/components';

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(t => React.Children.toArray(t.props.children).join(''));
}

it('ScoreRing starts its count-up from 0.0 on the very first mount, then snaps to the final score once isReduceMotionEnabled resolves true', async () => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockImplementation(
    () => Promise.resolve(true),
  );
  const rafQueue: Array<(t: number) => void> = [];
  jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation((cb: (t: number) => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ScoreRing score={7.2} />);
  });
  // Before the async probe resolves the cache still says "motion ok": the
  // number is at the count-up origin, not the final score, and a frame is
  // already scheduled.
  expect(texts(renderer)).toContain('0.0');
  expect(rafQueue.length).toBeGreaterThan(0);
  // The accessible label never depends on the animation state.
  expect(
    renderer.root.findAll(
      n => n.props.accessibilityLabel === 'Technique score 7.2 out of 10',
    ).length,
  ).toBeGreaterThan(0);

  await act(async () => {
    await Promise.resolve();
  });
  expect(texts(renderer)).toContain('7.2');
  expect(texts(renderer)).not.toContain('0.0');
  act(() => renderer.unmount());
  jest.restoreAllMocks();
});
