import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useReducedMotion } from '../design/components';
import { color, space, type } from '../design/tokens';
import { plural } from '../util/plural';
import { ChartDataRows } from './PracticeVolumeChart';
import type { ScoreTrendBucket } from './techniqueDashboard';

/**
 * WHOOP-style score trend bars (MOBBIN: WHOOP "Recovery statistics" weekly
 * chart): value labels ride on top of each bar for short windows, the newest
 * scored bucket wears the accent color, and the latest column sits on a
 * lifted "today" background. Buckets with no comparable reads render a stub —
 * an honest gap, never an interpolated bar. Enlarged text uses bounded,
 * flowing rows with the same averages and explicit grouped date ranges.
 */
export function ScoreTrendChart(props: {
  buckets: readonly ScoreTrendBucket[];
}) {
  const reducedMotion = useReducedMotion();
  const largeText = useWindowDimensions().fontScale > 1;
  const reveal = useRef(new Animated.Value(1)).current;
  const signature = props.buckets
    .map(bucket => `${bucket.key}:${bucket.avg ?? 'x'}`)
    .join('|');

  useEffect(() => {
    if (reducedMotion || largeText) {
      reveal.setValue(1);
      return;
    }
    reveal.setValue(0);
    Animated.timing(reveal, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [largeText, reducedMotion, reveal, signature]);

  const showLabels = props.buckets.length <= 8;
  const barCeiling = showLabels ? 58 : 72;
  const latestScoredIndex = props.buckets.reduce(
    (latest, bucket, index) => (bucket.avg !== null ? index : latest),
    -1,
  );
  const scoredBuckets = props.buckets.filter(bucket => bucket.avg !== null);
  const latestAvg =
    latestScoredIndex >= 0 ? props.buckets[latestScoredIndex]!.avg : null;

  const firstLabel = props.buckets[0]?.label ?? '';
  const lastLabel = props.buckets.at(-1)?.label ?? '';
  const middleLabel =
    props.buckets[Math.floor(props.buckets.length / 2)]?.label;

  const grouped = props.buckets.some(bucket => {
    const [first, last] = bucket.key.split(':');
    return last !== undefined && last !== first;
  });
  const period = grouped ? 'period' : 'day';
  const summary =
    scoredBuckets.length === 0
      ? 'No comparable scored reads in this window yet.'
      : `Average technique score by ${period}. ${scoredBuckets.length} scored ${plural(scoredBuckets.length, period)}${
          latestAvg === null
            ? ''
            : `, latest average ${latestAvg.toFixed(1)} out of 10`
        }.`;

  if (largeText) {
    return (
      <View
        accessible={false}
        accessibilityLabel={summary}
        importantForAccessibility="no"
        style={styles.root}
      >
        <ChartDataRows
          key={`${props.buckets[0]?.key}:${props.buckets.at(-1)?.key}`}
          items={props.buckets}
          summary={summary}
          scope={
            grouped
              ? 'Each row is one grouped date range, not a single day. Oldest to newest.'
              : 'Each row is one day, oldest to newest.'
          }
          unit="periods"
          rowForItem={(bucket, index) => {
            const [first, last] = bucket.key.split(':');
            const label =
              last && last !== first ? `${first}–${last}` : bucket.label;
            const latest = index === latestScoredIndex;
            const value =
              bucket.avg === null
                ? 'No comparable scored reads'
                : `${bucket.avg.toFixed(1)} out of 10 · ${bucket.count} scored ${plural(bucket.count, 'read')}`;
            return {
              key: bucket.key,
              label: `${label}: ${value}${latest ? ' · Latest scored period' : ''}`,
              latest,
            };
          }}
        />
      </View>
    );
  }

  return (
    <View accessible accessibilityLabel={summary} style={styles.root}>
      <View importantForAccessibility="no-hide-descendants" style={styles.plot}>
        {props.buckets.map((bucket, index) => {
          const isLatestColumn = index === props.buckets.length - 1;
          const isAccent = index === latestScoredIndex;
          const targetHeight =
            bucket.avg === null
              ? 4
              : 10 + (Math.min(bucket.avg, 10) / 10) * barCeiling;
          return (
            <View key={bucket.key} style={styles.barSlot}>
              {isLatestColumn ? <View style={styles.todayColumn} /> : null}
              {showLabels && bucket.avg !== null ? (
                <Text
                  style={[styles.barValue, isAccent && styles.barValueAccent]}
                >
                  {bucket.avg.toFixed(1)}
                </Text>
              ) : null}
              <Animated.View
                style={[
                  styles.bar,
                  bucket.avg === null && styles.barEmpty,
                  isAccent && styles.barAccent,
                  {
                    height: reveal.interpolate({
                      inputRange: [0, 1],
                      outputRange: [4, targetHeight],
                    }),
                  },
                ]}
              />
            </View>
          );
        })}
      </View>
      <View importantForAccessibility="no-hide-descendants" style={styles.axis}>
        <Text style={[styles.axisLabel, styles.axisLabelStart]}>
          {firstLabel}
        </Text>
        <Text style={[styles.axisLabel, styles.axisLabelMiddle]}>
          {middleLabel}
        </Text>
        <Text style={[styles.axisLabel, styles.axisLabelEnd]}>{lastLabel}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginTop: space.md },
  plot: {
    height: 96,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    paddingTop: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineMutedDark,
  },
  barSlot: {
    flex: 1,
    height: 92,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  todayColumn: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 6,
    backgroundColor: color.onDarkTintFaint,
  },
  barValue: {
    ...type.micro,
    color: color.onDarkMuted,
    letterSpacing: 0.2,
    marginBottom: 3,
    fontVariant: ['tabular-nums'],
  },
  barValueAccent: { color: color.volt },
  bar: {
    width: '100%',
    minWidth: 3,
    maxWidth: 30,
    borderRadius: 5,
    backgroundColor: color.onDarkMuted,
  },
  barAccent: { backgroundColor: color.volt },
  barEmpty: { backgroundColor: color.lineMutedDark },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 7,
  },
  axisLabel: {
    ...type.micro,
    flex: 1,
    color: color.onDarkMuted,
    letterSpacing: 0.2,
  },
  axisLabelStart: { textAlign: 'left' },
  axisLabelMiddle: { textAlign: 'center' },
  axisLabelEnd: { textAlign: 'right' },
});
