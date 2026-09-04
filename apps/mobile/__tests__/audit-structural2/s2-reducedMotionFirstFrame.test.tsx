/**
 * Structural audit #2: `useReducedMotion` seeds from a module-level default of
 * `false` and only learns the real OS preference once
 * `AccessibilityInfo.isReduceMotionEnabled()` resolves. The first render of
 * the first motion primitive in the process therefore animates for a user
 * who has Reduce Motion on. This file must be the first consumer of
 * design/components in its Jest module registry, so it lives alone.
 */
import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const stub = (name: string) => {
    const Stub = (props: Record<string, unknown>) =>
      ReactModule.createElement(View, { ...props, testID: `svg-${name}` });
    Stub.displayName = name;
    return Stub;
  };
  return {
    __esModule: true,
    default: stub('Svg'),
    Svg: stub('Svg'),
    Circle: stub('Circle'),
    Path: stub('Path'),
    Polyline: stub('Polyline'),
    Polygon: stub('Polygon'),
    Line: stub('Line'),
    Rect: stub('Rect'),
    Defs: stub('Defs'),
    LinearGradient: stub('LinearGradient'),
    Stop: stub('Stop'),
    G: stub('G'),
    Text: stub('Text'),
  };
});

const isReduceMotionEnabled =
  AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
    typeof AccessibilityInfo.isReduceMotionEnabled
  >;

describe('useReducedMotion initial frame', () => {
  it('renders the ScoreRing at rest on first paint when the OS reports Reduce Motion on', async () => {
    let resolveReduce!: (value: boolean) => void;
    isReduceMotionEnabled.mockImplementation(
      () =>
        new Promise<boolean>(resolve => {
          resolveReduce = resolve;
        }),
    );
    const { ScoreRing } = require('../../src/design/components') as {
      ScoreRing: typeof import('../../src/design/components').ScoreRing;
    };

    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(<ScoreRing score={7.5} />);
    });
    const numeral = () =>
      root.root
        .findAllByType(Text)
        .map(node => String(node.props.children))
        .find(text => /^\d+\.\d$/.test(text));

    const firstFrame = numeral();

    await act(async () => {
      resolveReduce(true);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
    const afterPreferenceKnown = numeral();

    act(() => root.unmount());

    // The preference is known to the OS before the app draws anything; the
    // very first frame should already show the final score for a
    // reduced-motion user, not the count-up start value.
    expect(afterPreferenceKnown).toBe('7.5');
    expect(firstFrame).toBe('7.5');
  });
});
