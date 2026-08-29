import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  Button,
  Card,
  PressableScale,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import {
  abstentionLedger,
  attemptChips,
  contactMarkerPresentation,
  isAbstainedResult,
  measuredRows,
  phaseTimelinePresentation,
  selectInsight,
  strokeResultHeader,
  visibleMeasuredRows,
  type AttemptRef,
  type PhaseSegmentKey,
  type StrokeResultEvidenceRecord,
} from './strokeResultModel';

/**
 * STROKE RESULT — the ONE canonical result surface (MOBBIN brief §1),
 * consumed by both Stroke Analysis and Session event cards through the
 * shared Result route. Every element is honest-evidence gated by the pure
 * selectors in strokeResultModel.ts; nothing renders from a field the
 * record does not carry.
 *
 * Hierarchy (brief §1): (1) technique title + honest source subtitle,
 * (2) replay card with scrubber / defensible contact marker / phase strip,
 * (3) ONE insight sentence, (4) measured rows with provenance (collapse >4),
 * (5) reserved hidden slot for coach-validated focus+drill, (6) CTA row.
 */

/** Replay clip reference — the real captured video file, when it exists. */
export interface StrokeResultClip {
  uri: string;
  durationMs: number;
}

export interface StrokeResultProps {
  /** Product-shape result, or null (family reads / honest abstentions). */
  analysis: ShotAnalysis | null;
  /** Full evidence record when available (strokeIntent, contact, phases…). */
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
  /** This session's attempts (chips navigate, NEVER rank — brief §2). */
  attempts?: readonly AttemptRef[];
  currentAnalysisId: string;
  onOpenAttempt?: (analysisId: string) => void;
  onTryAgain: () => void;
  onDone: () => void;
  /** Optional sections (e.g. validated training) between rows and the CTAs. */
  children?: React.ReactNode;
}

/** Phase colors from the existing palette only — never color-only (legend). */
const PHASE_COLOR: Record<PhaseSegmentKey, string> = {
  preparation: color.mint,
  acceleration: color.volt,
  follow_through: color.flame,
  recovery: color.court,
  swing: color.volt,
};

const PHASE_LABEL: Record<PhaseSegmentKey, string> = {
  preparation: 'Prep',
  acceleration: 'Accel',
  follow_through: 'Follow',
  recovery: 'Recovery',
  swing: 'Swing',
};

function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

// ─── §1.2 Replay card ───────────────────────────────────────────────────────

function ReplayCard(props: {
  analysis: ShotAnalysis | null;
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
}) {
  const reduced = useReducedMotion();
  const marker = contactMarkerPresentation(props.record?.contact);
  const timeline = phaseTimelinePresentation(props.record?.temporalPhasesV2);
  const analysis = props.analysis ?? props.record?.result ?? null;

  // Time base: full clip when the real video exists; else the analyzed
  // stroke window; else the measured phase extent. All values are real
  // recorded timestamps — no synthetic time axis.
  const base = useMemo(() => {
    if (props.clip && props.clip.durationMs > 0) {
      return { startMs: 0, endMs: props.clip.durationMs };
    }
    if (analysis) {
      const pad = 250;
      return {
        startMs: Math.max(0, analysis.timestamps.startMs - pad),
        endMs: analysis.timestamps.endMs + pad,
      };
    }
    if (timeline.kind === 'segments') {
      const first = timeline.segments[0];
      const last = timeline.segments[timeline.segments.length - 1];
      if (first && last) return { startMs: first.startMs, endMs: last.endMs };
    }
    return null;
  }, [analysis, props.clip, timeline]);

  const [trackWidth, setTrackWidth] = useState(0);
  const [playheadMs, setPlayheadMs] = useState(base?.startMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const playTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (playTimer.current) clearInterval(playTimer.current);
    },
    [],
  );

  if (!base || base.endMs <= base.startMs) {
    return (
      <Card tone="dark" style={styles.replayCard}>
        <Text style={[type.micro, { color: color.onDarkMuted }]}>REPLAY</Text>
        <Text style={[type.body, styles.replayEmpty]}>
          No replay evidence is stored for this stroke on this device.
        </Text>
      </Card>
    );
  }

  const span = base.endMs - base.startMs;
  const fraction = (ms: number) =>
    Math.min(1, Math.max(0, (ms - base.startMs) / span));
  const stopPlayback = () => {
    if (playTimer.current) clearInterval(playTimer.current);
    playTimer.current = null;
    setPlaying(false);
  };
  const seekToX = (event: GestureResponderEvent) => {
    if (trackWidth <= 0) return;
    stopPlayback();
    const ratio = Math.min(
      1,
      Math.max(0, event.nativeEvent.locationX / trackWidth),
    );
    setPlayheadMs(base.startMs + ratio * span);
  };
  const togglePlay = () => {
    if (playing) {
      stopPlayback();
      return;
    }
    setPlaying(true);
    const stepMs = reduced ? 120 : 40;
    playTimer.current = setInterval(() => {
      setPlayheadMs(current => {
        const next = current + stepMs;
        if (next >= base.endMs) {
          stopPlayback();
          return base.endMs;
        }
        return next;
      });
    }, stepMs);
  };

  const windowSpan =
    props.clip && analysis
      ? {
          startMs: analysis.timestamps.startMs,
          endMs: analysis.timestamps.endMs,
        }
      : null;

  return (
    <Card tone="dark" style={styles.replayCard} testID="stroke-result-replay">
      <View style={styles.replayHeader}>
        <Text style={[type.micro, { color: color.onDarkMuted }]}>REPLAY</Text>
        <Text style={[type.micro, styles.replayClock]}>
          {formatSeconds(playheadMs - base.startMs)}
        </Text>
      </View>

      <View style={styles.posterShell}>
        {props.clip ? (
          // Same degradation contract as TargetSelector: platforms that
          // cannot rasterize a still from the video URI show the dark
          // camera surface. The file itself is the real captured clip.
          <Image
            source={{ uri: props.clip.uri }}
            resizeMode="cover"
            style={StyleSheet.absoluteFill}
            accessibilityLabel="Captured clip"
          />
        ) : null}
        <View style={styles.posterBadge}>
          <Icon name="camera" size={14} color={color.onDarkMuted} />
          <Text style={[type.micro, { color: color.onDarkMuted }]}>
            {props.clip ? 'ON-DEVICE CLIP' : 'NO PER-EVENT CLIP STORED'}
          </Text>
        </View>
        <PressableScale
          accessibilityLabel={playing ? 'Pause replay' : 'Play replay'}
          onPress={togglePlay}
          containerStyle={styles.playContainer}
          style={styles.playButton}
        >
          <Icon
            name={playing ? 'pause' : 'play'}
            size={20}
            color={color.onVolt}
          />
        </PressableScale>
      </View>

      <View
        accessibilityLabel="Replay timeline scrubber"
        accessibilityHint="Drag to move through the analyzed clip"
        onLayout={event => setTrackWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={seekToX}
        onResponderMove={seekToX}
        style={styles.scrubTrack}
      >
        {windowSpan ? (
          <View
            style={[
              styles.windowShade,
              {
                left: `${fraction(windowSpan.startMs) * 100}%`,
                width: `${
                  (fraction(windowSpan.endMs) - fraction(windowSpan.startMs)) *
                  100
                }%`,
              },
            ]}
          />
        ) : null}
        {marker.kind === 'marker' ? (
          <View
            accessibilityLabel={`Contact marker, ${marker.caption}`}
            style={[
              styles.contactHalo,
              {
                left: `${
                  fraction(marker.contactMs - marker.haloHalfWidthMs) * 100
                }%`,
                width: `${Math.max(
                  0.5,
                  (fraction(marker.contactMs + marker.haloHalfWidthMs) -
                    fraction(marker.contactMs - marker.haloHalfWidthMs)) *
                    100,
                )}%`,
              },
            ]}
          >
            <View style={styles.contactTick} />
          </View>
        ) : null}
        <View
          style={[styles.playhead, { left: `${fraction(playheadMs) * 100}%` }]}
        />
      </View>

      {timeline.kind === 'segments' ? (
        <>
          <View style={styles.phaseStrip} accessibilityLabel="Phase timeline">
            {timeline.segments.map(segment => (
              <View
                key={`${segment.key}-${segment.startMs}`}
                style={[
                  styles.phaseSegment,
                  {
                    left: `${fraction(segment.startMs) * 100}%`,
                    width: `${Math.max(
                      1,
                      (fraction(segment.endMs) - fraction(segment.startMs)) *
                        100,
                    )}%`,
                    backgroundColor: PHASE_COLOR[segment.key],
                  },
                ]}
              />
            ))}
            {timeline.contactTickMs !== null ? (
              <View
                style={[
                  styles.phaseContactTick,
                  { left: `${fraction(timeline.contactTickMs) * 100}%` },
                ]}
              />
            ) : null}
          </View>
          <View style={styles.phaseLegend}>
            {timeline.segments.map(segment => (
              <View
                key={`legend-${segment.key}-${segment.startMs}`}
                style={styles.legendItem}
              >
                <View
                  style={[
                    styles.legendDot,
                    { backgroundColor: PHASE_COLOR[segment.key] },
                  ]}
                />
                <Text style={[type.micro, { color: color.onDarkMuted }]}>
                  {PHASE_LABEL[segment.key].toUpperCase()}
                </Text>
              </View>
            ))}
            {timeline.contactTickMs !== null ? (
              <View style={styles.legendItem}>
                <View
                  style={[styles.legendDot, { backgroundColor: color.onDark }]}
                />
                <Text style={[type.micro, { color: color.onDarkMuted }]}>
                  CONTACT
                </Text>
              </View>
            ) : null}
          </View>
          {timeline.caption ? (
            <Text style={[type.caption, styles.replayFootnote]}>
              {timeline.caption}
            </Text>
          ) : null}
        </>
      ) : timeline.reason ? (
        <Text style={[type.caption, styles.replayFootnote]}>
          Phase timing not shown — {timeline.reason}.
        </Text>
      ) : null}

      {marker.kind === 'not_established' ? (
        <Text style={[type.caption, styles.replayFootnote]}>
          {marker.caption}
        </Text>
      ) : null}

      <Text style={[type.caption, styles.replayDisclosure]}>
        Scrubbing moves the measured evidence timeline. This build does not
        render video frames in-app; the clip file stays on this device.
      </Text>
    </Card>
  );
}

// ─── The canonical surface ──────────────────────────────────────────────────

export function StrokeResult(props: StrokeResultProps) {
  const [rowsExpanded, setRowsExpanded] = useState(false);
  const analysis = props.analysis ?? props.record?.result ?? null;
  const header = strokeResultHeader(props.record, analysis);
  const insight = selectInsight({
    strokeIntent: props.record?.strokeIntent ?? null,
    contact: props.record?.contact ?? null,
    temporalPhasesV2: props.record?.temporalPhasesV2 ?? null,
    limitingFactors: props.record?.uncertainty?.limitingFactors ?? [],
  });
  const rows = measuredRows({ analysis, record: props.record });
  const { visible, hiddenCount } = visibleMeasuredRows(rows, rowsExpanded);
  const chips = attemptChips(props.attempts ?? [], props.currentAnalysisId);
  const abstained = isAbstainedResult(props.record, analysis);
  const ledger = abstained
    ? abstentionLedger({
        record: props.record,
        analysis,
        clipPresent: props.clip !== null,
      })
    : null;

  return (
    <View testID="stroke-result-surface">
      {/* §1.1 — WHAT WAS THE STROKE: title + honest source subtitle. */}
      <Text
        style={[
          type.micro,
          {
            color: header.tone === 'attention' ? color.warn : color.inkSoft,
          },
        ]}
      >
        {header.eyebrow}
      </Text>
      <Text style={[type.h1, styles.title]}>{header.title}</Text>
      <Text style={[type.body, styles.subtitle]}>{header.subtitle}</Text>

      {/* §2 — attempt chips: navigate between this session's attempts.
          NEVER a ranking: comparisons are blocked until metrics validate. */}
      {chips.length > 1 ? (
        <View
          style={styles.attemptRow}
          accessibilityRole="tablist"
          accessibilityLabel="Attempts in this session, in capture order"
        >
          {chips.map(chip => (
            <PressableScale
              key={chip.analysisId}
              accessibilityRole="tab"
              accessibilityLabel={chip.label}
              accessibilityState={{ selected: chip.isCurrent }}
              onPress={() =>
                chip.isCurrent
                  ? undefined
                  : props.onOpenAttempt?.(chip.analysisId)
              }
              style={[
                styles.attemptChip,
                chip.isCurrent && styles.attemptChipCurrent,
              ]}
            >
              <Text
                style={[
                  type.caption,
                  { color: chip.isCurrent ? color.onVolt : color.ink },
                ]}
              >
                {chip.label}
              </Text>
            </PressableScale>
          ))}
        </View>
      ) : null}

      {/* §1.2 — REPLAY card. */}
      <ReplayCard analysis={analysis} record={props.record} clip={props.clip} />

      {/* §1.3 — ONE INSIGHT: a single defensible sentence, never a tip. */}
      <Card tone="soft" style={styles.insightCard} testID="stroke-insight">
        <View style={styles.insightHeader}>
          <Icon name="spark" size={17} color={color.court} />
          <Text style={[type.micro, { color: color.court }]}>
            MEASURED INSIGHT
          </Text>
        </View>
        <Text style={[type.bodyBold, styles.insightSentence]}>
          {insight.sentence}
        </Text>
      </Card>

      {/* §4 — abstention is a designed state: what held / what we couldn't
          establish, in the same layout, with the retry CTA below. */}
      {ledger ? (
        <Card style={styles.ledgerCard} testID="abstention-ledger">
          <Text style={[type.micro, { color: color.inkSoft }]}>WHAT HELD</Text>
          {ledger.held.map(item => (
            <View key={item} style={styles.ledgerRow}>
              <Icon name="check" size={15} color={color.good} />
              <Text style={[type.caption, styles.ledgerCopy]}>{item}</Text>
            </View>
          ))}
          <Text style={[type.micro, styles.ledgerGapLabel]}>
            WHAT WE COULDN’T ESTABLISH
          </Text>
          {ledger.notEstablished.map(item => (
            <View key={item} style={styles.ledgerRow}>
              <Icon name="close" size={15} color={color.inkSoft} />
              <Text style={[type.caption, styles.ledgerCopy]}>{item}</Text>
            </View>
          ))}
          {analysis?.guidance ? (
            // Real setup guidance recorded by the engine for this capture —
            // the one retry path (§4), not a coaching tip.
            <Text style={[type.caption, styles.ledgerGuidance]}>
              {analysis.guidance}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {/*
       * §1.5 — RESERVED SLOT (hidden today): PRIMARY FOCUS + DRILL.
       * When coach-validated technique scoring unlocks (techniqueEvaluator
       * is BLOCKED_ON_VALIDATION in the shared profiles), a single
       * focus-plus-drill card enters HERE, between the insight and the
       * measured rows. Deliberately not rendered: there is no validated
       * focus/drill mapping to show, and nothing is faked in its place.
       */}

      {/* §1.4 — measured rows, provenance-labeled, collapsed beyond 4. */}
      {rows.length > 0 ? (
        <Card style={styles.rowsCard} testID="measured-rows">
          {visible.map(row => (
            <View key={row.key} style={styles.measuredRow}>
              <View style={styles.measuredCopy}>
                <Text style={[type.bodyBold, { color: color.ink }]}>
                  {row.label}
                </Text>
                <Text style={[type.caption, { color: color.inkSoft }]}>
                  {row.value}
                </Text>
              </View>
              <View style={styles.provenancePill}>
                <Text style={[type.micro, { color: color.inkSoft }]}>
                  {row.provenance}
                </Text>
              </View>
            </View>
          ))}
          {hiddenCount > 0 || rowsExpanded ? (
            <PressableScale
              accessibilityLabel={
                rowsExpanded ? 'Show fewer rows' : `See ${hiddenCount} more`
              }
              onPress={() => setRowsExpanded(current => !current)}
              style={styles.seeMore}
            >
              <Text style={[type.caption, { color: color.court }]}>
                {rowsExpanded ? 'Show fewer' : `See ${hiddenCount} more`}
              </Text>
            </PressableScale>
          ) : null}
        </Card>
      ) : null}

      {props.children}

      {/* §1.6 — CTA row: TRY AGAIN primary, Done secondary (brief §2 loop). */}
      <View style={styles.ctaRow}>
        <Button
          label="Try again"
          variant="volt"
          icon="camera"
          onPress={props.onTryAgain}
          testID="stroke-result-try-again"
        />
        <Button
          label="Done"
          variant="ghost"
          onPress={props.onDone}
          testID="stroke-result-done"
        />
      </View>
    </View>
  );
}

// ─── ANALYZING state — single-state arc + honest stage captions ─────────────

export function StrokeResultAnalyzing(props: {
  caption: string;
  detail?: string;
  dark?: boolean;
}) {
  const reduced = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 1400,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, spin]);

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
  const track = props.dark ? color.lineDark : color.line;
  const arc = props.dark ? color.volt : color.court;

  return (
    <View
      style={styles.analyzingWrap}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${props.caption} Keep Pickle Sensei open.`}
      testID="stroke-result-analyzing"
    >
      <Animated.View style={{ transform: [{ rotate }] }}>
        <Svg width={84} height={84} viewBox="0 0 84 84">
          <Circle
            cx="42"
            cy="42"
            r="36"
            stroke={track}
            strokeWidth="6"
            fill="none"
          />
          <Circle
            cx="42"
            cy="42"
            r="36"
            stroke={arc}
            strokeWidth="6"
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${2 * Math.PI * 36 * 0.72} ${
              2 * Math.PI * 36 * 0.28
            }`}
          />
        </Svg>
      </Animated.View>
      <Text
        style={[
          type.h2,
          styles.analyzingCaption,
          { color: props.dark ? color.onDark : color.ink },
        ]}
      >
        {props.caption}
      </Text>
      <Text
        style={[
          type.caption,
          styles.analyzingDetail,
          { color: props.dark ? color.onDarkSubtle : color.inkSoft },
        ]}
      >
        {props.detail ??
          'Only measured evidence will be shown — nothing is invented.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: color.ink, marginTop: space.sm },
  subtitle: { color: color.inkSoft, marginTop: space.xs, maxWidth: 370 },
  attemptRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: space.md,
  },
  attemptChip: {
    paddingHorizontal: 14,
    minHeight: 40,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
  },
  attemptChipCurrent: { borderColor: color.volt, backgroundColor: color.volt },
  replayCard: { marginTop: space.lg, padding: space.md },
  replayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  replayClock: { color: color.onDark, fontVariant: ['tabular-nums'] },
  replayEmpty: { color: color.onDarkMuted, marginTop: space.sm },
  posterShell: {
    height: 168,
    marginTop: space.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.cameraSurface,
    justifyContent: 'flex-end',
  },
  posterBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.overlayDeep,
  },
  playContainer: { position: 'absolute', bottom: 10, right: 10, width: 44 },
  playButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrubTrack: {
    height: 40,
    marginTop: space.md,
    borderRadius: radius.xs,
    backgroundColor: color.inkElevated,
    overflow: 'hidden',
  },
  windowShade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: color.onDarkTint,
  },
  contactHalo: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: color.voltSoft,
    opacity: 0.34,
    alignItems: 'center',
  },
  contactTick: {
    width: 2,
    flex: 1,
    backgroundColor: color.volt,
    opacity: 1,
  },
  playhead: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: 2,
    borderRadius: 1,
    backgroundColor: color.onDark,
  },
  phaseStrip: {
    height: 10,
    marginTop: space.sm,
    borderRadius: 5,
    backgroundColor: color.inkElevated,
    overflow: 'hidden',
  },
  phaseSegment: { position: 'absolute', top: 0, bottom: 0 },
  phaseContactTick: {
    position: 'absolute',
    top: -2,
    bottom: -2,
    width: 2,
    backgroundColor: color.onDark,
  },
  phaseLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    marginTop: space.sm,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 7, height: 7, borderRadius: 4 },
  replayFootnote: { color: color.onDarkSubtle, marginTop: space.sm },
  replayDisclosure: {
    color: color.onDarkFaint,
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  insightCard: { marginTop: space.md, padding: space.lg },
  insightHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  insightSentence: { color: color.ink, marginTop: space.sm },
  ledgerCard: { marginTop: space.md, padding: space.lg },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: space.sm,
  },
  ledgerCopy: { color: color.ink, flex: 1 },
  ledgerGapLabel: { color: color.inkSoft, marginTop: space.md },
  ledgerGuidance: {
    color: color.inkSoft,
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  rowsCard: { marginTop: space.md, paddingHorizontal: space.lg },
  measuredRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  measuredCopy: { flex: 1, gap: 2 },
  provenancePill: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceAlt,
  },
  seeMore: { minHeight: 44, justifyContent: 'center' },
  ctaRow: { gap: 10, marginTop: space.xl },
  analyzingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  analyzingCaption: { textAlign: 'center', marginTop: space.lg },
  analyzingDetail: { textAlign: 'center', marginTop: space.sm, maxWidth: 320 },
});
