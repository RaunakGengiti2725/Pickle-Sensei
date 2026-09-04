/**
 * `react-native-reanimated` alias: animations resolve to their end state
 * synchronously so layouts are measured at rest.
 */
import React, { type ComponentType } from "react";
import { View, Text, Image, ScrollView } from "./react-native";

export const Easing = {
  linear: (t: number) => t,
  ease: (t: number) => t,
  quad: (t: number) => t,
  cubic: (t: number) => t,
  bezier: () => (t: number) => t,
  out: (fn: (t: number) => number) => fn,
  in: (fn: (t: number) => number) => fn,
  inOut: (fn: (t: number) => number) => fn,
};

export function useSharedValue<T>(initial: T): { value: T } {
  return { value: initial };
}

export function useAnimatedStyle<T>(factory: () => T): T {
  return factory();
}

export function useAnimatedProps<T>(factory: () => T): T {
  return factory();
}

export function useDerivedValue<T>(factory: () => T): { value: T } {
  return { value: factory() };
}

export function withTiming<T>(toValue: T): T {
  return toValue;
}

export function withDelay<T>(_delay: number, animation: T): T {
  return animation;
}

export function withSpring<T>(toValue: T): T {
  return toValue;
}

export function withRepeat<T>(animation: T): T {
  return animation;
}

export function withSequence<T>(...animations: T[]): T {
  return animations[animations.length - 1] as T;
}

export function cancelAnimation(): void {}

export function runOnJS<F>(fn: F): F {
  return fn;
}

export function interpolate(value: number, input: number[], output: number[]): number {
  const last = input.length - 1;
  if (value <= input[0]!) return output[0]!;
  if (value >= input[last]!) return output[last]!;
  for (let i = 0; i < last; i++) {
    if (value >= input[i]! && value <= input[i + 1]!) {
      const t = (value - input[i]!) / (input[i + 1]! - input[i]!);
      return output[i]! + t * (output[i + 1]! - output[i]!);
    }
  }
  return output[last]!;
}

export function createAnimatedComponent<P>(component: ComponentType<P>): ComponentType<P> {
  return component;
}

const Reanimated = {
  View: View as unknown as ComponentType<Record<string, unknown>>,
  Text: Text as unknown as ComponentType<Record<string, unknown>>,
  Image: Image as unknown as ComponentType<Record<string, unknown>>,
  ScrollView: ScrollView as unknown as ComponentType<Record<string, unknown>>,
  createAnimatedComponent,
};

export default Reanimated;

export function FadeIn() {
  return React.Fragment;
}
