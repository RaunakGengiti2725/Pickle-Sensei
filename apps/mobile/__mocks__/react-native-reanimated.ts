/**
 * Jest auto-mock for react-native-reanimated. The real package boots
 * react-native-worklets' native initializers, which cannot load under jest.
 * This mock renders every animated component at its FINAL state: shared
 * values hold whatever the last animation targeted, and style/props
 * updaters run synchronously — so tests assert resting layout and copy,
 * never animation timing. Suites that need different behavior (e.g. the
 * PremiumTabBar tests) keep their own inline jest.mock, which wins.
 */
import * as React from 'react';

type AnyProps = Record<string, unknown> & {
  animatedProps?: Record<string, unknown>;
};

function createAnimatedComponent(
  Component: React.ComponentType<Record<string, unknown>>,
) {
  return function AnimatedComponent(props: AnyProps) {
    const { animatedProps, ...rest } = props;
    return React.createElement(Component, {
      ...rest,
      ...(animatedProps ?? {}),
    });
  };
}

const { View, Text, ScrollView, Image } = require('react-native');

const passthrough = (value: unknown) => value;

const Easing = {
  linear: passthrough,
  ease: passthrough,
  cubic: passthrough,
  quad: passthrough,
  exp: passthrough,
  bezier: () => passthrough,
  in: (fn: unknown) => fn,
  out: (fn: unknown) => fn,
  inOut: (fn: unknown) => fn,
};

module.exports = {
  __esModule: true,
  default: {
    View: createAnimatedComponent(View),
    Text: createAnimatedComponent(Text),
    ScrollView: createAnimatedComponent(ScrollView),
    Image: createAnimatedComponent(Image),
    createAnimatedComponent,
  },
  Easing,
  interpolate: () => 0,
  cancelAnimation: () => {},
  useSharedValue: (initial: unknown) => ({ value: initial }),
  useDerivedValue: (updater: () => unknown) => ({ value: updater() }),
  useAnimatedStyle: (updater: () => object) => updater(),
  useAnimatedProps: (updater: () => object) => updater(),
  withTiming: (toValue: unknown) => toValue,
  withSpring: (toValue: unknown) => toValue,
  withDelay: (_delay: number, animation: unknown) => animation,
  withRepeat: (animation: unknown) => animation,
  withSequence: (...animations: unknown[]) => animations.at(-1),
  runOnJS:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
  runOnUI:
    (fn: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) =>
      fn(...args),
};
