import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useReducedMotion } from '../design/components';
import { color, space, type } from '../design/tokens';
import type { PracticeHistoryChartBucket } from './practiceHistory';

const DATA_ROWS_PER_PAGE = 7;

export function ChartDataRows<T>(props: {
  items: readonly T[];
  summary: string;
  scope: string;
  unit: 'reads' | 'periods';
  rowForItem: (
    item: T,
    index: number,
  ) => { key: string; label: string; latest: boolean };
}) {
  const [pageFromLatest, setPageFromLatest] = useState(0);
  const lastPage = Math.max(
    0,
    Math.ceil(props.items.length / DATA_ROWS_PER_PAGE) - 1,
  );
  const page = Math.min(pageFromLatest, lastPage);
  const end = props.items.length - page * DATA_ROWS_PER_PAGE;
  const start = Math.max(0, end - DATA_ROWS_PER_PAGE);

  return (
    <View style={styles.dataRows}>
      <Text style={styles.dataText}>{props.summary}</Text>
      <Text style={styles.dataText}>{props.scope}</Text>
      <Text accessibilityLiveRegion="polite" style={styles.dataText}>
        {props.items.length === 0
          ? `No ${props.unit} in this window.`
          : `Showing ${props.unit} ${start + 1}–${end} of ${props.items.length}.`}
      </Text>
      {props.items.slice(start, end).map((item, offset) => {
        const row = props.rowForItem(item, start + offset);
        return (
          <Text
            key={row.key}
            accessible
            style={[styles.dataRow, row.latest && styles.dataRowLatest]}
            testID="chart-data-row"
          >
            {row.label}
          </Text>
        );
      })}
      {lastPage > 0 ? (
        <View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Earlier ${props.unit}`}
            accessibilityState={{ disabled: page === lastPage }}
            disabled={page === lastPage}
            onPress={() => setPageFromLatest(page + 1)}
            style={styles.dataPageButton}
            testID="chart-data-earlier"
          >
            <Text
              style={[styles.dataText, page < lastPage && styles.dataPageLink]}
            >{`Earlier ${props.unit}`}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Later ${props.unit}`}
            accessibilityState={{ disabled: page === 0 }}
            disabled={page === 0}
            onPress={() => setPageFromLatest(page - 1)}
            style={styles.dataPageButton}
            testID="chart-data-later"
          >
            <Text
              style={[styles.dataText, page > 0 && styles.dataPageLink]}
            >{`Later ${props.unit}`}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

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
  /** Replaces the default capture-volume summary when the bars count
   * something else (Home's scored reads). */
  accessibilityLabel?: string;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  const largeText = useWindowDimensions().fontScale > 1;
  const reveal = useRef(new Animated.Value(1)).current;
  const compacted = useMemo(
    () => compactPracticeBuckets(props.buckets),
    [props.buckets],
  );
  const signature = compacted.map(bucket => bucket.count).join(':');
  const maximum = Math.max(1, ...compacted.map(bucket => bucket.count));
  const total = compacted.reduce((sum, bucket) => sum + bucket.count, 0);

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

  const firstLabel = compacted[0]?.firstLabel ?? '';
  const lastLabel = compacted.at(-1)?.lastLabel ?? '';
  const middleLabel = compacted[Math.floor(compacted.length / 2)]?.firstLabel;
  // Compact labels fit short windows at default text size; enlarged text
  // uses bounded, flowing rows with the same totals as the chart bars.
  const showValues = compacted.length <= 7;
  const barCeiling = showValues ? 50 : 65;
  const summary =
    props.accessibilityLabel ??
    `${props.rangeLabel} capture volume: ${total} verified ${
      total === 1 ? 'capture' : 'captures'
    } across ${props.activeDays} active ${
      props.activeDays === 1 ? 'day' : 'days'
    }.`;

  if (largeText) {
    return (
      <View
        accessible={false}
        accessibilityLabel={summary}
        importantForAccessibility="no"
        style={styles.root}
        testID={props.testID}
      >
        <ChartDataRows
          key={`${compacted[0]?.key}:${compacted.at(-1)?.key}`}
          items={compacted}
          summary={summary}
          scope="Counts by chart period, oldest to newest. Grouped dates use the same totals as the chart bars."
          unit="periods"
          rowForItem={(bucket, index) => {
            const latest = index === compacted.length - 1;
            const label =
              bucket.firstLabel === bucket.lastLabel
                ? bucket.firstLabel
                : `${bucket.firstLabel}–${bucket.lastLabel}`;
            return {
              key: bucket.key,
              label: `${label}: ${bucket.count}${latest ? ' · Latest period' : ''}`,
              latest,
            };
          }}
        />
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityLabel={summary}
      style={styles.root}
      testID={props.testID}
    >
      <View importantForAccessibility="no-hide-descendants" style={styles.plot}>
        {compacted.map((bucket, index) => {
          const isLatest = index === compacted.length - 1;
          const targetHeight =
            bucket.count === 0 ? 4 : 13 + (bucket.count / maximum) * barCeiling;
          return (
            <View key={bucket.key} style={styles.barSlot}>
              {isLatest ? <View style={styles.todayColumn} /> : null}
              {showValues && bucket.count > 0 ? (
                <Text
                  style={[styles.barValue, isLatest && styles.barValueLatest]}
                >
                  {bucket.count}
                </Text>
              ) : null}
              <Animated.View
                style={[
                  styles.bar,
                  bucket.count === 0 && styles.barEmpty,
                  isLatest && bucket.count > 0 && styles.barLatest,
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
  dataRows: { gap: space.sm },
  dataText: { ...type.caption, color: color.onDarkMuted },
  dataRow: {
    ...type.caption,
    color: color.onDarkMuted,
    fontVariant: ['tabular-nums'],
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineMutedDark,
  },
  dataRowLatest: { color: color.volt },
  dataPageLink: { textDecorationLine: 'underline' },
  dataPageButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: space.sm,
  },
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
  barSlot: {
    flex: 1,
    height: 78,
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
  barValueLatest: { color: color.volt },
  bar: {
    width: '100%',
    minWidth: 3,
    borderRadius: 5,
    backgroundColor: color.onDarkMuted,
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
    color: color.onDarkMuted,
    letterSpacing: 0.2,
  },
  axisLabelStart: { textAlign: 'left' },
  axisLabelMiddle: { textAlign: 'center' },
  axisLabelEnd: { textAlign: 'right' },
});
