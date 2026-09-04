/**
 * Synchronous stand-in for `react-native-reanimated` covering every symbol
 * the signed-in app tree imports (Easing, shared values, timing/spring/
 * sequence/repeat/delay composers, animated styles/props, runOnJS,
 * cancelAnimation, interpolate, Animated.View, createAnimatedComponent).
 *
 * Reanimated's own `mock.js` pulls in `react-native-worklets`' native module
 * and cannot load under the RN jest preset without the worklets runtime, so
 * the whole App tree needs this hand-rolled equivalent. Animations resolve to
 * their target value immediately; nothing here schedules a timer, so any
 * timer the campaign finds leaked belongs to the app, never to this mock.
 *
 * Built via a factory (not a module-level object) so it can be returned from
 * a hoisted `jest.mock()` callback that has only `jest.requireActual`.
 */
export function makeReanimatedMock(
  React: typeof import('react'),
  ReactNative: typeof import('react-native'),
): Record<string, unknown> {
  const identityEasing = (value: number) => value;
  const easingFactory = () => identityEasing;
  const Easing = {
    linear: identityEasing,
    ease: identityEasing,
    quad: identityEasing,
    cubic: identityEasing,
    sin: identityEasing,
    circle: identityEasing,
    exp: identityEasing,
    poly: easingFactory,
    elastic: easingFactory,
    back: easingFactory,
    bounce: identityEasing,
    bezier: easingFactory,
    bezierFn: easingFactory,
    in: (fn: unknown) => fn,
    out: (fn: unknown) => fn,
    inOut: (fn: unknown) => fn,
    steps: easingFactory,
  };

  const animated = <Props extends object>(
    Component: React.ComponentType<Props>,
  ) => {
    const Wrapped = React.forwardRef<
      unknown,
      Props & { animatedProps?: object }
    >((props, ref) => {
      const { animatedProps, ...rest } = props;
      return React.createElement(Component, {
        ...(rest as Props),
        ...(animatedProps ?? {}),
        ref,
      });
    });
    Wrapped.displayName = `Animated(${Component.displayName ?? Component.name ?? 'Component'})`;
    return Wrapped;
  };

  const Animated = {
    View: animated(ReactNative.View),
    Text: animated(ReactNative.Text),
    Image: animated(ReactNative.Image),
    ScrollView: animated(ReactNative.ScrollView),
    FlatList: animated(ReactNative.FlatList),
    createAnimatedComponent: animated,
  };

  const unwrap = (value: unknown): unknown =>
    typeof value === 'function' ? (value as () => unknown)() : value;

  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    Easing,
    useSharedValue: <T>(initial: T) => React.useRef({ value: initial }).current,
    useDerivedValue: <T>(updater: () => T) => ({ value: updater() }),
    useAnimatedStyle: (updater: () => object) => updater(),
    useAnimatedProps: (updater: () => object) => updater(),
    useAnimatedReaction: () => {},
    withTiming: (toValue: unknown) => unwrap(toValue),
    withSpring: (toValue: unknown) => unwrap(toValue),
    withDelay: (_ms: number, animation: unknown) => animation,
    withRepeat: (animation: unknown) => animation,
    withSequence: (...animations: unknown[]) => animations.at(-1),
    cancelAnimation: () => {},
    runOnJS: <Args extends unknown[]>(fn: (...args: Args) => void) => fn,
    runOnUI: <Args extends unknown[]>(fn: (...args: Args) => void) => fn,
    interpolate: (
      value: number,
      input: readonly number[],
      output: readonly number[],
    ) => {
      if (input.length < 2 || output.length < 2) return output[0] ?? 0;
      const last = input.length - 1;
      if (value <= input[0]!) return output[0]!;
      if (value >= input[last]!) return output[last]!;
      for (let i = 0; i < last; i += 1) {
        const a = input[i]!;
        const b = input[i + 1]!;
        if (value >= a && value <= b) {
          const t = b === a ? 0 : (value - a) / (b - a);
          return output[i]! + t * (output[i + 1]! - output[i]!);
        }
      }
      return output[last]!;
    },
    Extrapolation: { CLAMP: 'clamp', EXTEND: 'extend', IDENTITY: 'identity' },
    FadeIn: {},
    FadeOut: {},
    Layout: {},
  };
}
