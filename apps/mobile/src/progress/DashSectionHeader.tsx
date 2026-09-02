import React from 'react';
import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { color, space, type } from '../design/tokens';

/**
 * WHOOP-style dashboard section header (MOBBIN: WHOOP "Key statistics"):
 * uppercase `type.micro` title with letterSpacing 1.2, optional right-aligned
 * context in the same role. The Progress dashboard's canonical section label
 * — shared with the cards that carry their own micro label (PracticeSetCard)
 * so the role renders identically everywhere (AGENTS.md typography canon).
 */
export function DashSectionHeader(props: {
  title: string;
  right?: string;
  /** Layout override for in-card use (the default margins suit page sections). */
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.dashHeader, props.style]}>
      <Text style={[type.micro, styles.dashHeaderTitle]}>{props.title}</Text>
      {props.right ? (
        <Text style={[type.micro, styles.dashHeaderRight]}>{props.right}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dashHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    marginTop: space.xl,
    marginBottom: space.sm + 4,
  },
  dashHeaderTitle: { color: color.onDarkMuted, letterSpacing: 1.2 },
  dashHeaderRight: { color: color.onDarkFaint, letterSpacing: 1.2 },
});
