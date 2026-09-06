import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { color } from '../design/tokens';

/**
 * The streak flame. Intensity follows the streak without a changing palette
 * or continuous motion:
 *
 *   0  ash      neutral outline (no streak)
 *   1  ember    single filled flame
 *   2  flame    filled flame with a defined core
 *   3  blaze    the same static training mark
 *   4  inferno  the same static training mark
 *   5  sensei   the same static training mark
 *
 * `AnimatedFlame` retains the hero API but renders the same resting mark
 * as `FlameIcon`. The streak number carries the earned intensity; neither
 * hero surfaces nor calendar cells run an idle animation.
 */

export type FlameIntensity = 0 | 1 | 2 | 3 | 4 | 5;

const OUTER_PATH =
  'M13.2 2.8c.7 3.5-1.6 4.8-2.7 6.4-.9 1.3-.8 2.7.3 3.7-.1-2.3 1.5-3.4 3-4.4.2 2 2.9 3.6 2.9 6.8 0 3.3-2.2 5.7-5.2 5.7s-5.3-2.3-5.3-5.6c0-4 3.2-6.2 7-12.6Z';
const INNER_PATH =
  'M12.7 11.6c.1 1.5 2 2.7 2 4.9 0 2-1.4 3.4-3.2 3.4s-3.2-1.4-3.2-3.3c0-2.6 2.2-3.6 4.4-5Z';

export function FlameIcon(props: {
  intensity: FlameIntensity;
  size?: number;
  dark?: boolean;
}) {
  const size = props.size ?? 22;
  const active = props.intensity > 0;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={OUTER_PATH}
        fill={active ? color.flame : 'none'}
        stroke={
          active
            ? color.inkElevated
            : props.dark
              ? color.onDarkSubtle
              : color.inkSoft
        }
        strokeWidth={active ? 1 : 1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {props.intensity > 1 ? (
        <Path d={INNER_PATH} fill={color.inkElevated} />
      ) : null}
    </Svg>
  );
}

/** Hero flame with the same static silhouette as the compact mark.
 * Intensity remains available to every existing consumer. */
export function AnimatedFlame(props: {
  intensity: FlameIntensity;
  size?: number;
  dark?: boolean;
}) {
  return (
    <FlameIcon
      intensity={props.intensity}
      size={props.size ?? 22}
      dark={props.dark ?? false}
    />
  );
}
