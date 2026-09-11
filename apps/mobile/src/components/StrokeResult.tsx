import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  BrandSpinner,
  Button,
  Card,
  PressableScale,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { ClipPlayer, clipPlaybackAvailable } from './ClipPlayer';
import {
  abstentionLedger,
  attemptChips,
  contactMarkerPresentation,
  effectivePhaseTimeline,
  isAbstainedResult,
  measuredRows,
  selectInsight,
  strokeResultHeader,
  visibleMeasuredRows,
  type AttemptRef,
  type PhaseSegmentKey,
  type StrokeResultEvidenceRecord,
} from './strokeResultModel';
import { UncertaintyNotes } from './UncertaintyNote';
import {
  AnalysisProgressBar,
  type AnalysisProgressUi,
} from './AnalysisProgress';

/**
 * STROKE RESULT — the ONE canonical result surface (MOBBIN brief §1),
 * consumed by both Stroke Analysis and Session event cards through the
 * shared Result route. Every element is honest-evidence gated by the pure
 * selectors in strokeResultModel.ts; nothing renders from a field the
 * record does not carry.
 *
 * Hierarchy (brief §1): (1) technique title + honest source subtitle,
 * (2) replay — the caller's `replaySlot` (the form-review player: real
 * frames, exoskeleton, checkpoint stops) when it has one, else the replay
 * card with scrubber / defensible contact marker / phase strip (from the
 * record, else the analysis' measured phases), then the caller's
 * `reviewSlot` (form-review entry), (3) ONE insight, then the caller's
 * `fixSlot` (what to fix / drills), (4) measured rows with provenance
 * (collapse >4), (5) `children` (validated training), (6) CTA row.
 *
 * The surface is dark (2026-09-10): every host — the Result guide's
 * not-scored page and the Full breakdown route — sits on the same dark
 * green the guide's pages use, so a result never switches to a light sheet.
 */

/** Replay clip reference — the real captured video file, when it exists. */
export interface StrokeResultClip {
  uri: string;
  durationMs: number;
  /** Poster still captured beside the video, when one was written. */
  posterUri?: string;
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
  /** Optional score stage rendered first, directly under the header block. */
  scoreSlot?: React.ReactNode;
  /**
   * Optional replay that REPLACES the built-in replay card (the form-review
   * player, with the exoskeleton and checkpoint stops). Absent → the card.
   */
  replaySlot?: React.ReactNode;
  /**
   * Recorded frame size of the clip, when known. The replay card sizes its
   * stage from it so a portrait phone clip shows the whole body ('contain')
   * instead of a 16:9 crop of the torso.
   */
  replayVideoSize?: { width: number; height: number } | null;
  /** Optional entry card rendered directly under the replay (form review). */
  reviewSlot?: React.ReactNode;
  /** Optional coaching content rendered right after the insight card
   * (what to fix / how to fix it / matched drills). */
  fixSlot?: React.ReactNode;
  /** Optional sections (e.g. validated training) between rows and the CTAs. */
  children?: React.ReactNode;
  /**
   * Omit the §1.6 CTA row. The Result guide pins TRY AGAIN / Done in its own
   * footer and embeds this surface as the "Full breakdown", so the row would
   * otherwise render twice. `onTryAgain` / `onDone` stay required so every
   * host still wires the loop (brief §2).
   */
  hideCtaRow?: boolean;
}

/** Phase colors from the existing palette only — never color-only (legend). */
const PHASE_COLOR: Record<PhaseSegmentKey, string> = {
  preparation: color.onDarkMuted,
  acceleration: color.volt,
  follow_through: color.onDarkMuted,
  recovery: color.onDarkMuted,
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

/** VoiceOver swipe-up/down moves the playhead by 1/20th of the timeline. */
const SCRUB_STEPS = 20;
const SCRUB_ACTIONS = [
  { name: 'increment' as const },
  { name: 'decrement' as const },
];

// ─── §1.2 Replay card ───────────────────────────────────────────────────────

/** Stage height for the landscape/unknown-size case (the historical card). */
const REPLAY_STAGE_LANDSCAPE = 168;
/** Tallest the stage grows for a portrait clip, so the card stays a card. */
const REPLAY_STAGE_MAX = 420;

/**
 * Stage height for the replay card: a portrait clip gets the height its
 * recorded aspect needs at the card's width (capped), so the whole body is
 * in frame; landscape or unknown sizes keep the historical 168pt band.
 */
export function replayStageHeight(
  videoSize: { width: number; height: number } | null | undefined,
  stageWidth: number,
): number {
  if (
    !videoSize ||
    !Number.isFinite(videoSize.width) ||
    !Number.isFinite(videoSize.height) ||
    videoSize.width <= 0 ||
    videoSize.height <= 0 ||
    videoSize.height <= videoSize.width ||
    !Number.isFinite(stageWidth) ||
    stageWidth <= 0
  ) {
    return REPLAY_STAGE_LANDSCAPE;
  }
  return Math.round(
    Math.min(
      REPLAY_STAGE_MAX,
      Math.max(
        REPLAY_STAGE_LANDSCAPE,
        (stageWidth * videoSize.height) / videoSize.width,
      ),
    ),
  );
}

function ReplayCard(props: {
  analysis: ShotAnalysis | null;
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
  videoSize?: { width: number; height: number } | null;
}) {
  const reduced = useReducedMotion();
  const [stageWidth, setStageWidth] = useState(0);
  const stageHeight = replayStageHeight(props.videoSize, stageWidth);
  const marker = contactMarkerPresentation(props.record?.contact);
  const analysis = props.analysis ?? props.record?.result ?? null;
  // Record-sourced phases first; else the analysis' own measured phases, so
  // every scored on-device result shows the strip it actually measured.
  const timeline = effectivePhaseTimeline(props.record, analysis);
  // The analysis' wrist-speed peak is drawn as a phase tick (named as such
  // in the legend); it is NOT the usable-result-v1 contact marker, so the
  // "no contact estimate was recorded" footnote would contradict the strip.
  const wristPeakTick =
    timeline.kind === 'segments' &&
    timeline.origin === 'analysis' &&
    timeline.contactTickMs !== null;

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
  // Last explicit scrub request handed to the native player (-1 = none).
  const [seekMs, setSeekMs] = useState(-1);
  const playTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // Real in-app video frames when the native player view exists for this
  // build; otherwise the card keeps its measured-timeline behavior.
  const nativePlayback = props.clip !== null && clipPlaybackAvailable();

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
  const seekTo = (ms: number) => {
    stopPlayback();
    const next = Math.min(base.endMs, Math.max(base.startMs, ms));
    setPlayheadMs(next);
    if (nativePlayback) setSeekMs(next - base.startMs);
  };
  const seekToX = (event: GestureResponderEvent) => {
    if (trackWidth <= 0) return;
    const ratio = Math.min(
      1,
      Math.max(0, event.nativeEvent.locationX / trackWidth),
    );
    seekTo(base.startMs + ratio * span);
  };
  const scrubStepMs = span / SCRUB_STEPS;
  const onScrubAccessibilityAction = (event: AccessibilityActionEvent) => {
    switch (event.nativeEvent.actionName) {
      case 'increment':
        seekTo(playheadMs + scrubStepMs);
        return;
      case 'decrement':
        seekTo(playheadMs - scrubStepMs);
        return;
      default:
        return;
    }
  };
  const togglePlay = () => {
    if (playing) {
      stopPlayback();
      return;
    }
    if (playheadMs >= base.endMs - 30) {
      // Replaying from the end restarts at the top of the clip.
      setPlayheadMs(base.startMs);
      if (nativePlayback) setSeekMs(0);
    }
    setPlaying(true);
    if (nativePlayback) return; // The native player drives real progress.
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

      <View
        style={[styles.posterShell, { height: stageHeight }]}
        onLayout={event => setStageWidth(event.nativeEvent.layout.width)}
        testID="stroke-result-replay-stage"
      >
        {props.clip ? (
          // Real frames from the real captured file, letterboxed so the whole
          // recorded frame — the whole body — is visible. ClipPlayer degrades
          // to the recorded poster still on builds without the native player
          // — never a fabricated frame.
          <ClipPlayer
            uri={props.clip.uri}
            {...(props.clip.posterUri !== undefined
              ? { posterUri: props.clip.posterUri }
              : {})}
            playing={playing}
            seekMs={seekMs}
            resizeMode="contain"
            onProgress={positionMs => {
              setPlayheadMs(base.startMs + positionMs);
            }}
            onEnd={() => {
              stopPlayback();
              setPlayheadMs(base.endMs);
            }}
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
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Replay timeline scrubber"
        accessibilityHint="Drag, or swipe up and down, to move through the analyzed clip"
        accessibilityValue={{
          min: 0,
          max: span,
          now: Math.round(playheadMs - base.startMs),
          text: formatSeconds(playheadMs - base.startMs),
        }}
        accessibilityActions={SCRUB_ACTIONS}
        onAccessibilityAction={onScrubAccessibilityAction}
        testID="stroke-result-scrubber"
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
                  {timeline.origin === 'analysis'
                    ? 'CONTACT (WRIST PEAK)'
                    : 'CONTACT'}
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

      {marker.kind === 'not_established' && !wristPeakTick ? (
        <Text style={[type.caption, styles.replayFootnote]}>
          {marker.caption}
        </Text>
      ) : null}

      <Text style={[type.caption, styles.replayDisclosure]}>
        {nativePlayback
          ? 'Playback and scrubbing stay on this device — the clip is ' +
            'never uploaded.'
          : 'Scrubbing moves the measured evidence timeline. The clip file ' +
            'stays on this device.'}
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
    analysis,
  });
  const insightMeasured =
    insight.basis === 'measured_fault' || insight.basis === 'measured_clean';
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
            color: header.tone === 'attention' ? color.flame : color.volt,
          },
        ]}
      >
        {header.eyebrow}
      </Text>
      <Text style={[type.h1, styles.title]}>{header.title}</Text>
      <Text style={[type.body, styles.subtitle]}>{header.subtitle}</Text>

      {/* Score-first: when the caller passes a score stage it renders here,
          directly under the header, so the score is the first thing seen —
          before the attempt chips and the replay card. */}
      {props.scoreSlot}

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
              hitSlop={4}
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
                  { color: chip.isCurrent ? color.onVolt : color.onDark },
                ]}
              >
                {chip.label}
              </Text>
            </PressableScale>
          ))}
        </View>
      ) : null}

      {/* §1.2 — REPLAY: the caller's player when it has one (exoskeleton,
          checkpoint stops), else the card. */}
      {props.replaySlot !== undefined ? (
        <View style={styles.replaySlot} testID="stroke-result-replay-slot">
          {props.replaySlot}
        </View>
      ) : (
        <ReplayCard
          analysis={analysis}
          record={props.record}
          clip={props.clip}
          videoSize={props.replayVideoSize ?? null}
        />
      )}

      {/* Caller-owned entry into the guided form review (paused replay with
          the measured stops), directly under the replay it extends. */}
      {props.reviewSlot}

      {/* §1.3 — ONE INSIGHT: the strongest defensible evidence. For a scored
          analysis that is the engine's own worst measured checkpoint plus
          the cue that matches its measured direction. */}
      <Card tone="dark" style={styles.insightCard} testID="stroke-insight">
        <View style={styles.insightHeader}>
          <Icon name="stroke" size={17} color={color.volt} />
          <Text style={[type.micro, { color: color.volt }]}>
            {insightMeasured ? 'WHAT THE CAMERA MEASURED' : 'MEASURED INSIGHT'}
          </Text>
        </View>
        <Text style={[type.bodyBold, styles.insightSentence]}>
          {insight.sentence}
        </Text>
      </Card>

      {/* Caller-owned coaching content: what to fix, how, and which drills. */}
      {props.fixSlot}

      {/* §4 — abstention is a designed state: what held / what we couldn't
          establish, in the same layout, with the retry CTA below. */}
      {ledger ? (
        <Card tone="dark" style={styles.ledgerCard} testID="abstention-ledger">
          <Text style={[type.micro, { color: color.mint }]}>WHAT HELD</Text>
          {ledger.held.map(item => (
            <View key={item} style={styles.ledgerRow}>
              <Icon name="check" size={15} color={color.mint} />
              <Text style={[type.caption, styles.ledgerCopy]}>{item}</Text>
            </View>
          ))}
          <Text style={[type.micro, styles.ledgerGapLabel]}>
            WHAT WE COULDN’T ESTABLISH
          </Text>
          {ledger.notEstablished.map(item => (
            <View key={item} style={styles.ledgerRow}>
              <Icon name="close" size={15} color={color.flame} />
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
          {ledger.scope ? (
            // The engine's measurement scope, stated once and calmly: the
            // paddle/ball/court are not tracked in this version. This is
            // not a gap this capture could have closed, so it never sits
            // under "what we couldn't establish".
            <View
              style={styles.ledgerScope}
              accessibilityRole="text"
              accessibilityLabel="Measurement scope"
              testID="abstention-ledger-scope"
            >
              <Icon name="shield" size={15} color={color.onDarkSubtle} />
              <Text style={[type.caption, styles.ledgerScopeCopy]}>
                {ledger.scope}
              </Text>
            </View>
          ) : null}
        </Card>
      ) : null}

      {/*
       * §1.5 — The focus + drill content for scored results arrives through
       * `fixSlot` above (FixList / RecommendedDrills, injected by the Result
       * route). Drill matching is by stroke family from the catalog and is
       * labeled as such — no coach-validated checkpoint mapping is claimed.
       */}

      {/* §1.4 — measured rows, provenance-labeled, collapsed beyond 4. */}
      {rows.length > 0 ? (
        <Card tone="dark" style={styles.rowsCard} testID="measured-rows">
          {visible.map(row => (
            <View key={row.key} style={styles.measuredRow}>
              <View style={styles.measuredCopy}>
                <Text style={[type.bodyBold, { color: color.onDark }]}>
                  {row.label}
                </Text>
                <Text style={[type.caption, { color: color.onDarkMuted }]}>
                  {row.value}
                </Text>
              </View>
              <View style={styles.provenancePill}>
                <Text style={[type.micro, { color: color.onDarkMuted }]}>
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
              <Text style={[type.caption, { color: color.volt }]}>
                {rowsExpanded ? 'Show fewer' : `See ${hiddenCount} more`}
              </Text>
            </PressableScale>
          ) : null}
        </Card>
      ) : null}

      {/* §4 — uncertainty microcopy: honest sentences for elements the
          evidence gates withheld above. The abstained path already carries
          the fuller ledger, so notes render only on scored results. */}
      {!abstained ? (
        <UncertaintyNotes record={props.record} analysis={analysis} />
      ) : null}

      {props.children}

      {/* §1.6 — CTA row: TRY AGAIN primary, Done secondary (brief §2 loop). */}
      {props.hideCtaRow ? null : (
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
      )}
    </View>
  );
}

// ─── ANALYZING state — mascot motion + honest stage captions ────────────────

export function StrokeResultAnalyzing(props: {
  caption: string;
  detail?: string;
  dark?: boolean;
  /**
   * Optional honest progress surface: a REAL measured fraction (imported
   * pose extraction) or an indeterminate stage pulse. Absent → the classic
   * arc-only state, byte-identical to before this prop existed.
   */
  progress?: AnalysisProgressUi | null;
}) {
  return (
    <View
      style={styles.analyzingWrap}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${props.caption} Keep Pickle Sensei open.`}
      testID="stroke-result-analyzing"
    >
      <View style={styles.analyzingVisual}>
        <BrandSpinner
          size={48}
          color={props.dark ? color.volt : color.court}
          trackColor={props.dark ? color.lineDark : color.line}
        />
      </View>
      <Text
        style={[
          type.h2,
          styles.analyzingCaption,
          { color: props.dark ? color.onDark : color.ink },
        ]}
      >
        {props.caption}
      </Text>
      {props.progress ? (
        <AnalysisProgressBar
          dark={props.dark}
          progress={props.progress.progress}
          label={props.progress.label}
          sublabel={props.progress.sublabel}
          testID="stroke-result-analyzing-progress"
        />
      ) : null}
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
  title: { color: color.onDark, marginTop: space.sm },
  subtitle: { color: color.onDarkMuted, marginTop: space.xs, maxWidth: 370 },
  attemptRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: space.md,
  },
  attemptChip: {
    paddingHorizontal: space.md,
    minHeight: 44,
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.lineDark,
    backgroundColor: color.inkElevated,
  },
  attemptChipCurrent: { borderColor: color.volt, backgroundColor: color.volt },
  replaySlot: { marginTop: space.lg },
  replayCard: { marginTop: space.lg, padding: space.md },
  replayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  replayClock: { color: color.onDark, fontVariant: ['tabular-nums'] },
  replayEmpty: { color: color.onDarkMuted, marginTop: space.sm },
  posterShell: {
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
  insightSentence: { color: color.onDark, marginTop: space.sm },
  ledgerCard: { marginTop: space.md, padding: space.lg },
  ledgerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: space.sm,
  },
  ledgerCopy: { color: color.onDark, flex: 1 },
  ledgerGapLabel: { color: color.flame, marginTop: space.md },
  ledgerGuidance: {
    color: color.onDarkMuted,
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  ledgerScope: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  ledgerScopeCopy: { color: color.onDarkSubtle, flex: 1 },
  rowsCard: { marginTop: space.md, paddingHorizontal: space.lg },
  measuredRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineDark,
  },
  measuredCopy: { flex: 1, gap: 2 },
  provenancePill: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.onDarkTint,
  },
  seeMore: { minHeight: 44, justifyContent: 'center' },
  ctaRow: { gap: 10, marginTop: space.xl },
  analyzingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
  },
  analyzingVisual: { width: 48, height: 48 },
  analyzingCaption: { textAlign: 'center', marginTop: space.lg },
  analyzingDetail: { textAlign: 'center', marginTop: space.sm, maxWidth: 320 },
});
