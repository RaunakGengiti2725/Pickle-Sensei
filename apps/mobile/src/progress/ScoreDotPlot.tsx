import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import { useReducedMotion } from '../design/components';
import { color, space, type } from '../design/tokens';
import { plural } from '../util/plural';
import type { ScoredReadPoint, ScoreTrendBucket } from './techniqueDashboard';

/**
 * Score dot plot: ONE dot per comparable scored read, placed in its day
 * column at its exact 0–10 score, so the picture is the real trajectory of
 * scores rather than a per-day aggregate. The newest read wears the accent,
 * a faint line traces the reads in time order, and (like the bar charts)
 * value labels ride on the dots only while the window is sparse enough to
 * read them. Days with no read stay empty — an honest gap, never a
 * carried-forward point.
 *
 * The plot is the same height as `PracticeVolumeChart` on purpose: Home
 * toggles between the two and the card must not jump.
 */

/** Matches PracticeVolumeChart's plot so the Home toggle never shifts layout. */
export const DOT_PLOT_HEIGHT = 82;
const BAND_TOP = 16;
const BAND_BOTTOM = 8;
const DOT_RADIUS = 4.5;
const LATEST_RADIUS = 5.5;
const HALO_SPREAD = 4;
const LABEL_HEIGHT = 13;
const LABEL_GAP = 3;
const LABEL_WIDTH = 36;
/** Beyond this many reads the labels would collide; the dots stay. */
const MAX_LABELED_READS = 8;
/** Same-day reads fan out horizontally by at most this many plot percent. */
const MAX_FAN_STEP_PCT = 4;
const STAGGER_MS = 30;
const REVEAL_MS = 240;

export interface DotPlotPoint {
  id: string;
  /** Horizontal center as a percentage of the plot width. */
  xPct: number;
  /** Vertical center in plot pixels from the top edge. */
  y: number;
  score: number;
  isLatest: boolean;
  /** Labels sit above the dot unless that would clip the plot's top edge. */
  labelSide: 'above' | 'below';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Plot-pixel y for a score: 10 sits on the top gridline, 0 on the baseline. */
export function yForScore(score: number, plotHeight = DOT_PLOT_HEIGHT): number {
  const band = plotHeight - BAND_TOP - BAND_BOTTOM;
  const clamped = Math.min(10, Math.max(0, score));
  return BAND_TOP + (1 - clamped / 10) * band;
}

/**
 * Pure layout. Buckets are ascending day groups keyed `first:last` (a lone
 * day may omit the `:last` half); every read's day falls in exactly one, and
 * reads that match no bucket are dropped rather than parked somewhere
 * plausible. Reads sharing a bucket fan out left→right in time order so no
 * dot hides another.
 */
export function dotPlotGeometry(
  buckets: readonly ScoreTrendBucket[],
  reads: readonly ScoredReadPoint[],
  plotHeight = DOT_PLOT_HEIGHT,
): DotPlotPoint[] {
  if (buckets.length === 0 || reads.length === 0) return [];
  const slotPct = 100 / buckets.length;
  const ranges = buckets.map(bucket => {
    const [first, last] = bucket.key.split(':');
    return { first: first ?? bucket.key, last: last ?? first ?? bucket.key };
  });
  const byBucket = new Map<number, ScoredReadPoint[]>();
  for (const read of reads) {
    const index = ranges.findIndex(
      range => read.day >= range.first && read.day <= range.last,
    );
    if (index === -1) continue;
    byBucket.set(index, [...(byBucket.get(index) ?? []), read]);
  }
  const latestId = reads.at(-1)?.id;
  const points: DotPlotPoint[] = [];
  for (const [index, group] of byBucket) {
    const center = (index + 0.5) * slotPct;
    const step =
      group.length > 1
        ? Math.min((slotPct * 0.7) / (group.length - 1), MAX_FAN_STEP_PCT)
        : 0;
    group.forEach((read, position) => {
      const isLatest = read.id === latestId;
      const radius = isLatest ? LATEST_RADIUS : DOT_RADIUS;
      const y = yForScore(read.score, plotHeight);
      points.push({
        id: read.id,
        xPct: center + (position - (group.length - 1) / 2) * step,
        y,
        score: read.score,
        isLatest,
        labelSide: labelSideFor(y, radius, position, plotHeight),
      });
    });
  }
  return points.sort((left, right) => left.xPct - right.xPct);
}

/**
 * Labels stay inside the plot (a dot against the top edge labels below, one
 * against the baseline labels above) and, within a same-day fan, alternate
 * sides so two labels a few points apart never print over each other.
 */
function labelSideFor(
  y: number,
  radius: number,
  positionInDay: number,
  plotHeight: number,
): DotPlotPoint['labelSide'] {
  const fitsAbove = y - radius - LABEL_GAP - LABEL_HEIGHT >= 0;
  const fitsBelow = y + radius + LABEL_GAP + LABEL_HEIGHT <= plotHeight;
  if (!fitsAbove) return 'below';
  if (!fitsBelow) return 'above';
  return positionInDay % 2 === 1 ? 'below' : 'above';
}

export function ScoreDotPlot(props: {
  buckets: readonly ScoreTrendBucket[];
  reads: readonly ScoredReadPoint[];
  rangeLabel: string;
}) {
  const reducedMotion = useReducedMotion();
  const reveal = useRef(new Animated.Value(1)).current;
  const [plotWidth, setPlotWidth] = useState(0);
  const points = useMemo(
    () => dotPlotGeometry(props.buckets, props.reads),
    [props.buckets, props.reads],
  );
  const signature = points.map(point => `${point.id}:${point.score}`).join('|');
  const staggered = Math.min(Math.max(points.length - 1, 0), 7);
  const duration = REVEAL_MS + staggered * STAGGER_MS;

  useEffect(() => {
    if (reducedMotion) {
      reveal.setValue(1);
      return;
    }
    reveal.setValue(0);
    Animated.timing(reveal, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [duration, reducedMotion, reveal, signature]);

  const readCount = props.reads.length;
  const dayCount = new Set(props.reads.map(read => read.day)).size;
  const latest = props.reads.at(-1) ?? null;
  const showLabels = points.length <= MAX_LABELED_READS;
  const slotCount = Math.max(1, props.buckets.length);
  const firstLabel = props.buckets[0]?.label ?? '';
  const lastLabel = props.buckets.at(-1)?.label ?? '';
  const middleLabel =
    props.buckets[Math.floor(props.buckets.length / 2)]?.label;
  // Points run left→right, which IS time order (ascending day columns,
  // same-day reads fanned out chronologically), so the trace needs no resort.
  const linePoints =
    plotWidth > 0 && points.length >= 2
      ? points
          .map(
            point =>
              `${round2((point.xPct / 100) * plotWidth)},${round2(point.y)}`,
          )
          .join(' ')
      : null;

  const onPlotLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width > 0 && width !== plotWidth) setPlotWidth(width);
  };

  return (
    <View
      accessible
      accessibilityLabel={
        readCount === 0
          ? 'No scored reads in this window yet.'
          : `${props.rangeLabel} technique scores: ${readCount} scored ${plural(
              readCount,
              'read',
            )} across ${dayCount} ${plural(dayCount, 'day')}, latest ${
              latest?.score.toFixed(1) ?? ''
            } out of 10.`
      }
      style={styles.root}
      testID="score-dot-plot"
    >
      <View
        importantForAccessibility="no-hide-descendants"
        onLayout={onPlotLayout}
        style={styles.plot}
      >
        <View pointerEvents="none" style={styles.slots}>
          {Array.from({ length: slotCount }, (_, index) => (
            <View
              key={index}
              style={[
                styles.slot,
                index === slotCount - 1 && styles.todayColumn,
              ]}
            />
          ))}
        </View>
        <View
          pointerEvents="none"
          style={[styles.gridline, { top: yForScore(10) }]}
        />
        <View
          pointerEvents="none"
          style={[styles.gridline, { top: yForScore(5) }]}
        />
        <Text style={[styles.scaleLabel, { top: yForScore(10) - 14 }]}>10</Text>
        <Text style={[styles.scaleLabel, { top: yForScore(5) - 14 }]}>5</Text>
        {linePoints ? (
          <Animated.View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { opacity: reveal }]}
          >
            <Svg width={plotWidth} height={DOT_PLOT_HEIGHT}>
              <Polyline
                points={linePoints}
                fill="none"
                stroke={color.mint}
                strokeOpacity={0.45}
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </Animated.View>
        ) : null}
        {points.map((point, index) => {
          const radius = point.isLatest ? LATEST_RADIUS : DOT_RADIUS;
          const start = (Math.min(index, 7) * STAGGER_MS) / duration;
          const end = Math.min(1, start + REVEAL_MS / duration);
          const progress = reveal.interpolate({
            inputRange: [0, start, end, 1],
            outputRange: [0, 0, 1, 1],
          });
          const scale = progress.interpolate({
            inputRange: [0, 1],
            outputRange: [0.6, 1],
          });
          const disc = (size: number) => ({
            left: `${point.xPct}%` as const,
            top: point.y - size,
            width: size * 2,
            height: size * 2,
            borderRadius: size,
            marginLeft: -size,
            opacity: progress,
            transform: [{ scale }],
          });
          return (
            <React.Fragment key={point.id}>
              {point.isLatest ? (
                <Animated.View
                  pointerEvents="none"
                  style={[styles.halo, disc(radius + HALO_SPREAD)]}
                />
              ) : null}
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.dot,
                  point.isLatest && styles.dotLatest,
                  disc(radius),
                ]}
              />
            </React.Fragment>
          );
        })}
        {showLabels
          ? points.map(point => {
              const radius = point.isLatest ? LATEST_RADIUS : DOT_RADIUS;
              return (
                <View
                  key={`${point.id}:label`}
                  pointerEvents="none"
                  style={[
                    styles.valueWrap,
                    {
                      left: `${point.xPct}%`,
                      top:
                        point.labelSide === 'above'
                          ? point.y - radius - LABEL_GAP - LABEL_HEIGHT
                          : point.y + radius + LABEL_GAP,
                    },
                  ]}
                >
                  <Text
                    style={[styles.value, point.isLatest && styles.valueLatest]}
                  >
                    {point.score.toFixed(1)}
                  </Text>
                </View>
              );
            })
          : null}
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
    height: DOT_PLOT_HEIGHT,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineMutedDark,
  },
  slots: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
  },
  slot: { flex: 1 },
  todayColumn: {
    marginHorizontal: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  gridline: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.lineMutedDark,
  },
  scaleLabel: {
    ...type.micro,
    position: 'absolute',
    right: 0,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.2,
    color: color.onDarkFaint,
    fontVariant: ['tabular-nums'],
  },
  dot: {
    position: 'absolute',
    backgroundColor: color.mint,
  },
  dotLatest: { backgroundColor: color.volt },
  // The newest read sits in a translucent volt halo drawn as its own disc
  // underneath (a translucent border would just blend into the core).
  halo: {
    position: 'absolute',
    backgroundColor: 'rgba(215,250,69,0.22)',
  },
  valueWrap: {
    position: 'absolute',
    width: LABEL_WIDTH,
    marginLeft: -LABEL_WIDTH / 2,
    alignItems: 'center',
  },
  value: {
    ...type.micro,
    color: color.onDarkMuted,
    fontSize: 10,
    lineHeight: LABEL_HEIGHT,
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
  valueLatest: { color: color.volt },
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
