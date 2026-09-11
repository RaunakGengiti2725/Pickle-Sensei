import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { color, type } from '../design/tokens';
import {
  DUPR_LABEL,
  duprAccessibilityLabel,
  formatDupr,
  formatTechniqueScore,
} from './duprEstimate';

/**
 * The one way a rating is printed anywhere in the app: the estimated DUPR
 * as the big numeral (in whatever numeral role the host surface uses) with
 * the "DUPR" unit beside it, and the underlying Technique Score as the
 * smaller "/10" line beneath. Keeping the two readings in one component means
 * no surface can show a DUPR without saying so, or drop the score it came
 * from.
 */
export function DuprReadout(props: {
  /** The 0–10 Technique Score or rank rating. */
  score: number;
  /** Decimals of the "/10" line: analyses are tenths, the rank rating hundredths. */
  scoreDecimals?: 1 | 2;
  /** The numeral role of the host surface (type.score, type.display, …). */
  valueStyle: StyleProp<TextStyle>;
  dark?: boolean;
  align?: 'flex-start' | 'flex-end' | 'center';
  /**
   * Whether this readout is its own VoiceOver element. Hosts that already
   * label a pressable row pass false and fold `duprAccessibilityLabel` into
   * their own label instead.
   */
  accessible?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const decimals = props.scoreDecimals ?? 1;
  const unitColor = props.dark ? color.onDarkSubtle : color.inkSoft;
  const secondaryColor = props.dark ? color.onDarkFaint : color.inkSoft;
  const accessible = props.accessible ?? true;
  return (
    <View
      accessible={accessible}
      accessibilityLabel={
        accessible ? duprAccessibilityLabel(props.score, decimals) : undefined
      }
      style={[{ alignItems: props.align ?? 'flex-end' }, props.style]}
      testID={props.testID}
    >
      <Text
        style={props.valueStyle}
        testID={props.testID && `${props.testID}-dupr`}
      >
        {formatDupr(props.score)}
        <Text style={[type.micro, { color: unitColor }]}>
          {` ${DUPR_LABEL}`}
        </Text>
      </Text>
      <Text
        style={[type.micro, styles.secondary, { color: secondaryColor }]}
        testID={props.testID && `${props.testID}-score`}
      >
        {formatTechniqueScore(props.score, decimals)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  secondary: { fontVariant: ['tabular-nums'] },
});
