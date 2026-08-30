import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from '../design/components';
import { color, radius, space, type } from '../design/tokens';

/**
 * ANALYSIS PROGRESS — the honest progress surface for the capture→analysis
 * flow.
 *
 * Two modes, one rule: a percentage is shown ONLY where a real measured
 * fraction exists (the native imported-video pose-extraction pass, which
 * reports `progress` ~every 10%). Every other stage is a bounded await with
 * no incremental signal, so it renders as an INDETERMINATE pulse with an
 * honest stage label — never a fabricated percentage.
 *
 * The ETA is derived from the native events themselves: an exponential
 * moving average of the measured extraction rate, recomputed on every event
 * so a stale estimate is never frozen on screen.
 */

// ─── ETA math (pure — unit-tested directly) ─────────────────────────────────

/** Running ETA state for one imported-video pose-extraction pass. */
export interface ExtractionEtaState {
  /** Wall-clock ms of the most recent native progress event. */
  lastTimestampMs: number;
  /** Native-reported completed fraction (0..1) at that event. */
  lastProgress: number;
  /**
   * Exponential moving average of the measured extraction rate, in fraction
   * per millisecond. Null until two events with forward progress have been
   * observed — before that no rate has actually been measured.
   */
  smoothedRatePerMs: number | null;
  /** Progress events observed for this pass so far. */
  eventCount: number;
}

/** EMA weight of the newest measured rate (rest stays with history). */
export const ETA_RATE_SMOOTHING = 0.4;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Folds one native progress event into the ETA state. Pure: returns a new
 * state, never mutates. The rate updates only on measurable forward motion
 * (Δt > 0 and Δprogress > 0); stalls and clock ties keep the last measured
 * rate rather than inventing one, and a regressing fraction is displayed
 * as reported but never turned into a negative rate.
 */
export function observeExtractionProgress(
  previous: ExtractionEtaState | null,
  timestampMs: number,
  progress: number,
): ExtractionEtaState {
  const fraction = clamp01(progress);
  if (!previous) {
    return {
      lastTimestampMs: timestampMs,
      lastProgress: fraction,
      smoothedRatePerMs: null,
      eventCount: 1,
    };
  }
  const deltaMs = timestampMs - previous.lastTimestampMs;
  const deltaProgress = fraction - previous.lastProgress;
  let smoothedRatePerMs = previous.smoothedRatePerMs;
  if (deltaMs > 0 && deltaProgress > 0) {
    const measuredRatePerMs = deltaProgress / deltaMs;
    smoothedRatePerMs =
      smoothedRatePerMs === null
        ? measuredRatePerMs
        : ETA_RATE_SMOOTHING * measuredRatePerMs +
          (1 - ETA_RATE_SMOOTHING) * smoothedRatePerMs;
  }
  return {
    lastTimestampMs: timestampMs,
    lastProgress: fraction,
    smoothedRatePerMs,
    eventCount: previous.eventCount + 1,
  };
}

/**
 * Whole seconds remaining, from the smoothed measured rate: rounded UP and
 * clamped to ≥1s so the copy never promises "0s" while work continues.
 * Null (no estimate) until ≥2 events produced a real rate, and once the
 * reported fraction reaches 1 — an ETA is never invented at either edge.
 */
export function extractionEtaSeconds(
  state: ExtractionEtaState | null,
): number | null {
  if (!state || state.eventCount < 2) return null;
  if (state.smoothedRatePerMs === null || state.smoothedRatePerMs <= 0) {
    return null;
  }
  const remainingFraction = 1 - state.lastProgress;
  if (remainingFraction <= 0) return null;
  const remainingMs = remainingFraction / state.smoothedRatePerMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Sublabel for the extraction stage: "x%" until an ETA is honestly
 * measurable, then "x% · ~Ns left". Null before any event has arrived.
 */
export function extractionSublabel(
  state: ExtractionEtaState | null,
): string | null {
  if (!state) return null;
  const percent = `${Math.round(state.lastProgress * 100)}%`;
  const etaSeconds = extractionEtaSeconds(state);
  return etaSeconds === null ? percent : `${percent} · ~${etaSeconds}s left`;
}

// ─── Stage model (what the screen actually knows) ───────────────────────────

/**
 * The analysis flow's honest stages, in the order the screen observes them:
 * - verifying: the user's declaration/tap are persisted with the capture row;
 * - extracting: imported videos only — the native pose pass with REAL
 *   progress events;
 * - measuring: runCaptureAnalysis is in flight (sidecar hash + parse +
 *   permit + on-device fusion) and exposes no incremental progress;
 * - saving: the outcome returned and the result is being routed.
 */
export type AnalysisStageKey =
  'verifying' | 'extracting' | 'measuring' | 'saving';

export const ANALYSIS_STAGE_LABELS: Record<AnalysisStageKey, string> = {
  verifying: 'Verifying capture evidence',
  extracting: 'Reading player movement',
  measuring: 'Measuring your swing',
  saving: 'Saving your result',
};

/** Static, honest overall hint for the unmeasured stages. */
export const ANALYSIS_DURATION_HINT = 'usually under ~10 seconds';

/** One renderable snapshot of the progress surface. */
export interface AnalysisProgressUi {
  stage: AnalysisStageKey;
  /** Real measured fraction (extraction only), or null → indeterminate. */
  progress: number | null;
  label: string;
  sublabel: string | null;
}

/** Indeterminate snapshot for a stage with no measurable fraction. */
export function analysisStageProgress(
  stage: Exclude<AnalysisStageKey, 'extracting'>,
): AnalysisProgressUi {
  return {
    stage,
    progress: null,
    label: ANALYSIS_STAGE_LABELS[stage],
    sublabel: ANALYSIS_DURATION_HINT,
  };
}

/**
 * Extraction snapshot from the live ETA state: indeterminate until the
 * first native event, then the real fraction with the honest sublabel.
 */
export function extractionProgress(
  eta: ExtractionEtaState | null,
): AnalysisProgressUi {
  return {
    stage: 'extracting',
    progress: eta ? eta.lastProgress : null,
    label: ANALYSIS_STAGE_LABELS.extracting,
    sublabel: extractionSublabel(eta),
  };
}

// ─── Progress bar component ─────────────────────────────────────────────────

/**
 * Design-system progress bar. Determinate mode animates the fill width to
 * the real measured fraction; indeterminate mode shows a gentle full-width
 * opacity pulse — never a fake percentage. Reduced motion snaps the fill
 * and holds the pulse static instead of animating.
 */
export function AnalysisProgressBar(props: {
  /** Completed fraction 0..1, or null for indeterminate. */
  progress: number | null;
  label: string;
  sublabel?: string | null;
  dark?: boolean;
  testID?: string;
}) {
  const reduced = useReducedMotion();
  const determinate = props.progress !== null;
  const fraction = clamp01(props.progress ?? 0);
  const fill = useRef(new Animated.Value(fraction)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!determinate) return;
    if (reduced) {
      // Reduced motion: snap to the measured value instead of animating.
      fill.setValue(fraction);
      return;
    }
    const animation = Animated.timing(fill, {
      toValue: fraction,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      // Width is a layout property — the native driver cannot animate it.
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [determinate, fill, fraction, reduced]);

  useEffect(() => {
    if (determinate) {
      pulse.setValue(1);
      return;
    }
    if (reduced) {
      // Reduced motion: a static mid-opacity fill, no loop.
      pulse.setValue(0.7);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 720,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 0.9,
          duration: 720,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [determinate, pulse, reduced]);

  const trackColor = props.dark ? color.onDarkTint : color.surfaceAlt;
  const fillColor = props.dark ? color.volt : color.court;
  const fillWidth = determinate
    ? fill.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
    : '100%';

  return (
    <View
      style={styles.wrap}
      testID={props.testID ?? 'analysis-progress'}
      accessibilityRole="progressbar"
      accessibilityLabel={
        props.sublabel ? `${props.label}. ${props.sublabel}` : props.label
      }
      accessibilityValue={
        determinate
          ? { min: 0, max: 100, now: Math.round(fraction * 100) }
          : { min: 0, max: 100 }
      }
    >
      <View style={styles.labelRow}>
        <Text
          style={[
            type.caption,
            styles.label,
            { color: props.dark ? color.onDark : color.ink },
          ]}
          numberOfLines={1}
        >
          {props.label}
        </Text>
        {props.sublabel ? (
          <Text
            style={[
              type.caption,
              styles.sublabel,
              { color: props.dark ? color.onDarkSubtle : color.inkSoft },
            ]}
            numberOfLines={1}
          >
            {props.sublabel}
          </Text>
        ) : null}
      </View>
      <View style={[styles.track, { backgroundColor: trackColor }]}>
        <Animated.View
          testID="analysis-progress-fill"
          style={[
            styles.fill,
            { backgroundColor: fillColor, width: fillWidth, opacity: pulse },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: '100%',
    maxWidth: 340,
    alignSelf: 'center',
    marginTop: space.lg,
    gap: space.sm,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  label: { flexShrink: 1 },
  sublabel: { fontVariant: ['tabular-nums'] },
  track: {
    height: 6,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
  },
});
