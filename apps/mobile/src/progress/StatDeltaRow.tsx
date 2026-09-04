import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { deltaDirection } from './techniqueDashboard';

/**
 * WHOOP-style key-statistic row (MOBBIN: WHOOP "Key statistics" / "Sleep
 * statistics"): icon chip, uppercase label, big right-aligned value with the
 * prior-window value beneath it and a delta triangle beside it. The triangle
 * and prior value render only when a real prior window exists — a first
 * measured window shows the value alone, never a fabricated comparison. The
 * triangle reads the delta at display precision: a change that rounds away,
 * or two identical rendered values, is flat — never a trend claim.
 */
export function StatDeltaRow(props: {
  icon: IconName;
  label: string;
  value: string;
  /** Formatted prior-window value; null hides the comparison entirely. */
  previous: string | null;
  /** Sign picks the triangle direction; null, 0, or a delta that rounds to
   * zero at `deltaDecimals` renders no triangle. */
  delta: number | null;
  /** Decimals the value renders at; omit for exact (integer) deltas. */
  deltaDecimals?: number;
  testID?: string;
}) {
  const readDirection =
    props.delta === null || props.value === props.previous
      ? 'flat'
      : deltaDirection(props.delta, props.deltaDecimals ?? null);
  const direction = readDirection === 'flat' ? null : readDirection;
  const comparison =
    props.previous === null
      ? ''
      : `. Prior period ${props.previous}${
          direction === null
            ? ''
            : direction === 'up'
              ? ', trending up'
              : ', trending down'
        }`;

  return (
    <View
      accessible
      accessibilityLabel={`${props.label}: ${props.value}${comparison}`}
      style={styles.row}
      testID={props.testID}
    >
      <View style={styles.iconChip}>
        <Icon name={props.icon} size={17} color={color.volt} />
      </View>
      <Text numberOfLines={1} style={[type.micro, styles.label]}>
        {props.label}
      </Text>
      <View style={styles.valueWrap}>
        <View style={styles.valueRow}>
          <Text style={styles.value}>{props.value}</Text>
          {direction ? (
            <View
              style={[
                styles.triangle,
                direction === 'up' ? styles.triangleUp : styles.triangleDown,
              ]}
            />
          ) : null}
        </View>
        {props.previous !== null ? (
          <Text style={[type.caption, styles.previous]}>{props.previous}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 4,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(215,250,69,0.1)',
  },
  label: {
    flex: 1,
    minWidth: 0,
    color: color.onDarkMuted,
    letterSpacing: 1,
  },
  valueWrap: { alignItems: 'flex-end' },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  value: {
    ...type.h3,
    fontSize: 20,
    lineHeight: 25,
    color: color.onDark,
    fontVariant: ['tabular-nums'],
  },
  previous: {
    color: color.onDarkFaint,
    marginTop: 1,
    fontVariant: ['tabular-nums'],
  },
  // Border-built triangles keep the delta glyph vector-crisp at any scale
  // without adding an icon asset.
  triangle: {
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
  triangleUp: { borderBottomWidth: 7, borderBottomColor: color.mint },
  triangleDown: { borderTopWidth: 7, borderTopColor: color.flame },
});
