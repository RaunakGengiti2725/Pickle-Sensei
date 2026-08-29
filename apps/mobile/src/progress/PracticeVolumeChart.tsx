import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from '../design/components';
import { color, space, type } from '../design/tokens';
import type { PracticeHistoryChartBucket } from './practiceHistory';

interface CompactBucket {
  key: string;
  firstLabel: string;
  lastLabel: string;
  count: number;
}

export function compactPracticeBuckets(
  buckets: readonly PracticeHistoryChartBucket[],
  maximumBars = 13,
): CompactBucket[] {
  if (buckets.length === 0) return [];
  const groupSize = Math.max(1, Math.ceil(buckets.length / maximumBars));
  const compacted: CompactBucket[] = [];
  for (let index = 0; index < buckets.length; index += groupSize) {
    const group = buckets.slice(index, index + groupSize);
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) continue;
    compacted.push({
      key: `${first.key}:${last.key}`,
      firstLabel: first.label,
      lastLabel: last.label,
      count: group.reduce((sum, bucket) => sum + bucket.count, 0),
    });
  }
  return compacted;
}

export function PracticeVolumeChart(props: {
  buckets: readonly PracticeHistoryChartBucket[];
  rangeLabel: string;
  activeDays: number;
}) {
  const reducedMotion = useReducedMotion();
  const reveal = useRef(new Animated.Value(1)).current;
  const compacted = useMemo(
    () => compactPracticeBuckets(props.buckets),
    [props.buckets],
  );
  const signature = compacted.map(bucket => bucket.count).join(':');
  const maximum = Math.max(1, ...compacted.map(bucket => bucket.count));
  const total = compacted.reduce((sum, bucket) => sum + bucket.count, 0);

  useEffect(() => {
    if (reducedMotion) {
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
  }, [reducedMotion, reveal, signature]);

  const firstLabel = compacted[0]?.firstLabel ?? '';
  const lastLabel = compacted.at(-1)?.lastLabel ?? '';
  const middleLabel = compacted[Math.floor(compacted.length / 2)]?.firstLabel;

  return (
    <View
      accessible
      accessibilityLabel={`${
        props.rangeLabel
      } capture volume: ${total} verified automatic ${
        total === 1 ? 'capture' : 'captures'
      } across ${props.activeDays} active ${
        props.activeDays === 1 ? 'day' : 'days'
      }.`}
      style={styles.root}
    >
      <View importantForAccessibility="no-hide-descendants" style={styles.plot}>
        {compacted.map((bucket, index) => {
          const targetHeight =
            bucket.count === 0 ? 4 : 13 + (bucket.count / maximum) * 65;
          return (
            <View key={bucket.key} style={styles.barSlot}>
              <Animated.View
                style={[
                  styles.bar,
                  bucket.count === 0 && styles.barEmpty,
                  index === compacted.length - 1 &&
                    bucket.count > 0 &&
                    styles.barLatest,
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
  root: { marginTop: space.lg },
  plot: {
    height: 82,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    paddingTop: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineMutedDark,
  },
  barSlot: { flex: 1, height: 78, justifyContent: 'flex-end' },
  bar: {
    width: '100%',
    minWidth: 3,
    borderRadius: 5,
    backgroundColor: color.mint,
  },
  barLatest: { backgroundColor: color.volt },
  barEmpty: { backgroundColor: color.lineMutedDark },
  axis: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 7,
  },
  axisLabel: {
    ...type.micro,
    flex: 1,
    color: color.onDarkFaint,
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 0.2,
  },
  axisLabelStart: { textAlign: 'left' },
  axisLabelMiddle: { textAlign: 'center' },
  axisLabelEnd: { textAlign: 'right' },
});
