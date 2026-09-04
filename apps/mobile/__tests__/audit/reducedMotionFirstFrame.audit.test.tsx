/**
 * AUDIT PROBE — useReducedMotion first-frame race (components.tsx:57-69).
 *
 * `useReducedMotion` seeds its state from a module-level `reducedMotionValue`
 * that is `false` until `AccessibilityInfo.isReduceMotionEnabled()` resolves.
 * Any animation started between the first hook mount and that resolution
 * therefore runs for a reduced-motion user. This file owns a fresh module
 * registry so the observer has not been started by another suite.
 */
import React from 'react';
import { AccessibilityInfo, Animated, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, props, props.children);
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

import { PressableScale, useReducedMotion } from '../../src/design/components';

let resolveReduceMotion: ((value: boolean) => void) | null = null;

beforeAll(() => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockImplementation(
    () =>
      new Promise<boolean>(resolve => {
        resolveReduceMotion = resolve;
      }),
  );
});

function Probe() {
  const reduced = useReducedMotion();
  return <Text testID="probe">{reduced ? 'reduced' : 'motion'}</Text>;
}

const grantEvent = {
  persist: () => {},
  currentTarget: { measure: () => {} },
  nativeEvent: { pageX: 0, pageY: 0, timestamp: 0, touches: [] },
  touchHistory: { touchBank: [] },
};

describe('useReducedMotion before the native query resolves', () => {
  it('PROBE: a press that lands before isReduceMotionEnabled resolves (true) must not animate', () => {
    const timing = jest.spyOn(Animated, 'timing');
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <>
          <Probe />
          <PressableScale onPress={jest.fn()}>
            <Text>x</Text>
          </PressableScale>
        </>,
      );
    });
    expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(typeof resolveReduceMotion).toBe('function');

    const host = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.onResponderGrant !== undefined,
    );
    act(() => {
      host.props.onResponderGrant(grantEvent);
    });

    // The OS setting IS on for this user; the app simply had not heard yet.
    const probe = renderer.root.findByProps({ testID: 'probe' });
    expect(probe.props.children).toBe('motion');
    expect(timing).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('VERIFIED: once resolved true, later mounts start reduced and presses do not animate', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    timing.mockClear();
    await act(async () => {
      resolveReduceMotion?.(true);
      await Promise.resolve();
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <>
          <Probe />
          <PressableScale onPress={jest.fn()}>
            <Text>x</Text>
          </PressableScale>
        </>,
      );
    });
    const probe = renderer.root.findByProps({ testID: 'probe' });
    expect(probe.props.children).toBe('reduced');
    const host = renderer.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.onResponderGrant !== undefined,
    );
    act(() => {
      host.props.onResponderGrant(grantEvent);
    });
    expect(timing).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('VERIFIED: an unmounted subscriber is dropped — a later reduceMotionChanged event does not warn', () => {
    const listener = (
      AccessibilityInfo.addEventListener as jest.Mock
    ).mock.calls.find(call => call[0] === 'reduceMotionChanged')?.[1];
    expect(typeof listener).toBe('function');
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe />);
    });
    act(() => renderer.unmount());
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    act(() => {
      listener(false);
      listener(true);
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
