import React, { useEffect } from 'react';
import { View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useReducedMotion } from '../design/components';

/**
 * The streak flame. Intensity escalates with the streak the way Duolingo's
 * does — a longer run literally burns hotter:
 *
 *   0  ash      cold gray outline (no streak)
 *   1  ember    soft single flame
 *   2  flame    warmer body, bright core
 *   3  blaze    deep orange, hot yellow core
 *   4  inferno  red-orange edge, white-hot core
 *   5  sensei   volt-core flame — the house style's highest honor
 *
 * `AnimatedFlame` adds a gentle flicker (scale/sway loop, transform-only,
 * reduced-motion aware) for hero surfaces; the plain `FlameIcon` is static
 * for lists and calendar cells.
 */

export type FlameIntensity = 0 | 1 | 2 | 3 | 4 | 5;

const OUTER_PATH =
  'M13.2 2.8c.7 3.5-1.6 4.8-2.7 6.4-.9 1.3-.8 2.7.3 3.7-.1-2.3 1.5-3.4 3-4.4.2 2 2.9 3.6 2.9 6.8 0 3.3-2.2 5.7-5.2 5.7s-5.3-2.3-5.3-5.6c0-4 3.2-6.2 7-12.6Z';
const INNER_PATH =
  'M12.7 11.6c.1 1.5 2 2.7 2 4.9 0 2-1.4 3.4-3.2 3.4s-3.2-1.4-3.2-3.3c0-2.6 2.2-3.6 4.4-5Z';

const PALETTES: Record<
  FlameIntensity,
  { edge: string; body: string; core: string }
> = {
  0: { edge: '#8B958E', body: '#B9C2BB', core: '#D5DCD6' },
  1: { edge: '#E08A3C', body: '#FFB061', core: '#FFD9A6' },
  2: { edge: '#F27B22', body: '#FF9B42', core: '#FFE08A' },
  3: { edge: '#E85D0F', body: '#FF8329', core: '#FFD34D' },
  4: { edge: '#D9430C', body: '#FF6D1F', core: '#FFF3C9' },
  5: { edge: '#C93A0A', body: '#FF7A1E', core: '#D7FA45' },
};

export function FlameIcon(props: { intensity: FlameIntensity; size?: number }) {
  const size = props.size ?? 22;
  const palette = PALETTES[props.intensity];
  const gradientId = `flameBody${props.intensity}`;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Defs>
        <LinearGradient id={gradientId} x1="0.5" y1="0" x2="0.5" y2="1">
          <Stop offset="0" stopColor={palette.edge} />
          <Stop offset="1" stopColor={palette.body} />
        </LinearGradient>
      </Defs>
      <Path
        d={OUTER_PATH}
        fill={props.intensity === 0 ? 'none' : `url(#${gradientId})`}
        stroke={props.intensity === 0 ? palette.edge : 'none'}
        strokeWidth={props.intensity === 0 ? 1.8 : 0}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {props.intensity > 0 ? <Path d={INNER_PATH} fill={palette.core} /> : null}
    </Svg>
  );
}

/** Hero flame with a living flicker: slow sway + core-driven scale breaths.
 * Higher intensity flickers faster and leans harder. */
export function AnimatedFlame(props: {
  intensity: FlameIntensity;
  size?: number;
}) {
  const reduced = useReducedMotion();
  const flicker = useSharedValue(0);
  const active = !reduced && props.intensity > 0;
  const period = 1400 - props.intensity * 120;

  useEffect(() => {
    if (!active) {
      flicker.value = 0;
      return;
    }
    flicker.value = withRepeat(
      withSequence(
        withTiming(1, { duration: period, easing: Easing.inOut(Easing.quad) }),
        withTiming(0, { duration: period, easing: Easing.inOut(Easing.quad) }),
      ),
      -1,
    );
    return () => cancelAnimation(flicker);
  }, [active, flicker, period]);

  const lean = 1 + props.intensity * 0.4;
  const style = useAnimatedStyle(() => ({
    transform: [
      { rotate: `${(flicker.value - 0.5) * lean}deg` },
      { scaleY: 1 + flicker.value * 0.05 },
      { scaleX: 1 - flicker.value * 0.03 },
    ],
  }));

  return (
    <View>
      <Animated.View style={style}>
        <FlameIcon intensity={props.intensity} size={props.size ?? 22} />
      </Animated.View>
    </View>
  );
}
