import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import type { PhaseSpan, ShotAnalysis } from '@pickle/shared-types';
import { PressableScale, useReducedMotion } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { ClipPlayer, clipPlaybackAvailable } from '../components/ClipPlayer';
import type { StrokeResultClip } from '../components/StrokeResult';
import type { StrokeReviewEvidence } from '../components/strokeResultData';
import {
  jointHeatAt,
  poseFrameAt,
  reviewVideoSize,
  type FormReviewScript,
  type ReviewPoseSequence,
  type ReviewStop,
  type StopVerdict,
} from './formReviewModel';
import {
  REVIEW_SPEEDS,
  clamp01,
  containRect,
  currentStop,
  nextAutoPause,
  speedLabel,
  type Rect,
} from './formReviewGeometry';
import {
  FormReviewOverlay,
  arrowGeometry,
  arrowLabelAnchor,
} from './FormReviewOverlay';

/**
 * FORM REVIEW PLAYER — the flagship replay as ONE reusable component. The
 * captured clip plays back with the recorded pose drawn as an exoskeleton, a
 * translucent heat map over the joints the scored faults were measured from,
 * and an arrow on the joint that needs to move. Playback pauses itself at
 * every measured checkpoint moment with the coaching caption for that stop.
 *
 * Layout (music-player style — NOTHING is drawn over the body): the stage
 * carries only the video, the exoskeleton and the arrow with its label. Three
 * fixed-height siblings sit under it, so they never scroll away and never
 * cover a joint: the STOP CARD (verdict · phase, "STOP n OF m", the measured
 * headline, the coaching cue), the TIMELINE (scrubber with verdict-colored
 * stop markers and the clock) and ONE symmetric transport row (speed · prev ·
 * play/pause · next · AUTO-pause). A tap on the stage toggles play/pause. In
 * `fill` mode the stage takes all the height its parent leaves after those
 * rows, so a host can pin header + player + CTAs with no scroll.
 *
 * Two hosts render it: the full-screen `FormReview` route and the Result
 * guide's "The problem" page (inline). Both hand it the same evidence — the
 * analysis, the clip file (or null), the recorded frame size and the
 * hash-verified pose sequence (or null) — and the same pure script.
 *
 * Honesty contract: everything shown traces to the analysis record and the
 * hash-verified pose sidecar. A missing clip shows the pose alone; a missing
 * or corrupt sidecar shows the clip alone; nothing is interpolated or
 * invented to fill either gap.
 */

export interface FormReviewPlayerProps {
  analysis: ShotAnalysis;
  clip: StrokeResultClip | null;
  review: StrokeReviewEvidence | null;
  sequence: ReviewPoseSequence | null;
  script: FormReviewScript;
  /** Open frozen on this stop (deep link from "See it in your form review"). */
  initialStop?: ReviewStop | null;
  /**
   * Stage height in points for the FIXED layout. Absent → a viewport-derived
   * default (as much of the window as reads well inline). Ignored when
   * `fill` is set.
   */
  stageHeight?: number;
  /**
   * FILL layout: the player becomes a `flex: 1` column and the stage takes
   * ALL the height its parent gives it — hosts that pin the replay between a
   * header and a footer use this so nothing has to scroll.
   */
  fill?: boolean;
}

/** Verdict word + the ONE palette tint it carries (dot, label, marker). The
 * word is always printed, so color is never the sole carrier. */
const VERDICT: Record<StopVerdict, { label: string; tint: string }> = {
  fix: { label: 'FIX', tint: color.flame },
  watch: { label: 'WATCH', tint: color.volt },
  strong: { label: 'STRONG', tint: color.mint },
};

/** Fallback stage aspect (portrait phone capture) when nothing recorded a size. */
const DEFAULT_VIDEO = { width: 9, height: 16 };
const TICK_MS = 1000 / 30;
const END_TOLERANCE_MS = 30;
const EXTENT_PAD_MS = 250;
const TRACK_HEIGHT = 32;
const TRACK_BAND_HEIGHT = 4;
const STOP_MARKER = 10;
const PLAYHEAD_KNOB = 14;
/** The cue reserves three body lines (every cue is ≤ 120 characters) so the
 * stage never resizes when the shown stop changes. */
const CUE_MIN_HEIGHT = type.body.lineHeight * 3;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatClock(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

function measuredPhases(analysis: ShotAnalysis): PhaseSpan[] {
  const raw = Array.isArray(analysis.phases) ? analysis.phases : [];
  return raw.filter(
    phase => phase && finite(phase.startMs) && finite(phase.endMs),
  );
}

/** Time base without a clip: the recorded extent of what was measured. */
function measuredExtentMs(
  analysis: ShotAnalysis,
  script: FormReviewScript,
  sequence: ReviewPoseSequence | null,
): number {
  let end = finite(analysis.timestamps?.endMs) ? analysis.timestamps.endMs : 0;
  for (const phase of measuredPhases(analysis)) {
    end = Math.max(end, phase.endMs);
  }
  for (const stop of script.stops) end = Math.max(end, stop.endMs);
  const last = sequence?.frames[sequence.frames.length - 1];
  if (last && finite(last.timestampMs)) end = Math.max(end, last.timestampMs);
  return Math.max(1000, end + EXTENT_PAD_MS);
}

/**
 * The honest caption on the stage when replay evidence is partial. Null
 * when both the clip and the verified pose sequence exist. `clipUnreadable`
 * is the native player reporting that the stored clip could not be opened
 * — the same absence as a missing clip record, discovered later.
 */
export function replayStageCaption(
  clip: StrokeResultClip | null,
  sequence: ReviewPoseSequence | null,
  clipUnreadable = false,
): string | null {
  if (clip === null || clipUnreadable) {
    return sequence
      ? 'The clip file is gone from this device; the measured pose is shown instead.'
      : 'No clip file or recorded pose is stored for this stroke on this device. The checkpoints below are still the ones the engine scored.';
  }
  return sequence === null
    ? 'No verified pose sequence is stored for this clip, so the replay shows the video without an exoskeleton.'
    : null;
}

export function FormReviewPlayer(props: FormReviewPlayerProps) {
  const { analysis, clip, sequence, script } = props;
  const stops = script.stops;
  const initialStop = props.initialStop ?? null;
  const fill = props.fill === true;
  const reduced = useReducedMotion();
  const viewport = useWindowDimensions();

  // The native player could not open the stored file: its layer would sit
  // black forever, so it is taken down and the stage says what happened.
  const [clipUnreadable, setClipUnreadable] = useState(false);

  // Real frames when the native player exists for this build and a clip
  // file is stored and readable; otherwise a JS clock drives the measured
  // pose alone.
  const nativeDriven =
    clip !== null && !clipUnreadable && clipPlaybackAvailable();

  const [durationMs, setDurationMs] = useState(() =>
    clip && clip.durationMs > 0
      ? clip.durationMs
      : measuredExtentMs(analysis, script, sequence),
  );
  const [playheadMs, setPlayheadMs] = useState(initialStop?.atMs ?? 0);
  const [playing, setPlaying] = useState(false);
  const [seekMs, setSeekMs] = useState(initialStop?.atMs ?? -1);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [autoPause, setAutoPause] = useState(true);
  const [activeStopId, setActiveStopId] = useState<string | null>(
    initialStop?.id ?? null,
  );
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [trackWidth, setTrackWidth] = useState(0);
  const [labelSize, setLabelSize] = useState({ width: 0, height: 0 });

  const playheadRef = useRef(initialStop?.atMs ?? 0);
  const playingRef = useRef(false);
  const scrubbingRef = useRef(false);
  const autoPauseRef = useRef(true);
  // Opening on a stop counts every earlier stop as seen, exactly like a jump.
  const visitedRef = useRef(
    new Set<string>(
      initialStop
        ? stops.filter(stop => stop.atMs <= initialStop.atMs).map(s => s.id)
        : [],
    ),
  );
  const lastSeekRef = useRef(initialStop?.atMs ?? -1);
  autoPauseRef.current = autoPause;

  const rate = REVIEW_SPEEDS[speedIndex] ?? 1;

  const setPlayingState = useCallback((value: boolean) => {
    playingRef.current = value;
    setPlaying(value);
  }, []);

  const movePlayhead = useCallback((ms: number) => {
    playheadRef.current = ms;
    setPlayheadMs(ms);
  }, []);

  /** Every request must differ numerically or the native view ignores it. */
  const requestSeek = useCallback((ms: number) => {
    const next = ms === lastSeekRef.current ? ms + 0.01 : ms;
    lastSeekRef.current = next;
    setSeekMs(next);
  }, []);

  /** Freeze on a checkpoint frame and show its caption. */
  const pauseAt = useCallback(
    (stop: ReviewStop) => {
      visitedRef.current.add(stop.id);
      setPlayingState(false);
      movePlayhead(stop.atMs);
      requestSeek(stop.atMs);
      setActiveStopId(stop.id);
    },
    [movePlayhead, requestSeek, setPlayingState],
  );

  /**
   * One progress tick (native or JS clock): move, then apply auto-pause. A
   * tick that lands after a pause (a late native event, a JS tick already
   * queued in the same frame) is ignored so the checkpoint frame stays put.
   */
  const advanceTo = useCallback(
    (positionMs: number) => {
      if (!playingRef.current) return;
      const previous = playheadRef.current;
      movePlayhead(positionMs);
      if (!autoPauseRef.current || scrubbingRef.current) return;
      const stop = nextAutoPause(
        stops,
        previous,
        positionMs,
        visitedRef.current,
      );
      if (stop) pauseAt(stop);
    },
    [movePlayhead, pauseAt, stops],
  );

  const finish = useCallback(() => {
    setPlayingState(false);
    visitedRef.current.clear();
    movePlayhead(durationMs);
    setActiveStopId(null);
  }, [durationMs, movePlayhead, setPlayingState]);

  // JS clock for pose-only replay (and builds without the native player).
  useEffect(() => {
    if (nativeDriven || !playing) return;
    const timer = setInterval(() => {
      const next = playheadRef.current + TICK_MS * rate;
      if (next >= durationMs) {
        advanceTo(durationMs);
        finish();
        return;
      }
      advanceTo(next);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [advanceTo, durationMs, finish, nativeDriven, playing, rate]);

  const togglePlay = () => {
    if (playingRef.current) {
      setPlayingState(false);
      return;
    }
    if (playheadRef.current >= durationMs - END_TOLERANCE_MS) {
      visitedRef.current.clear();
      movePlayhead(0);
      requestSeek(0);
    }
    setActiveStopId(null);
    setPlayingState(true);
  };

  /** A jump re-arms every stop ahead of the new position. */
  const jumpTo = (ms: number, stopId: string | null) => {
    setPlayingState(false);
    visitedRef.current = new Set(
      stops.filter(stop => stop.atMs <= ms).map(stop => stop.id),
    );
    movePlayhead(ms);
    requestSeek(ms);
    setActiveStopId(stopId);
  };

  const seekToX = (event: GestureResponderEvent) => {
    if (trackWidth <= 0 || durationMs <= 0) return;
    scrubbingRef.current = true;
    const ratio = clamp01(event.nativeEvent.locationX / trackWidth);
    jumpTo(ratio * durationMs, null);
  };
  const endScrub = () => {
    scrubbingRef.current = false;
  };

  // ── Derived frame state ────────────────────────────────────────────────
  const videoSize = useMemo(() => {
    const review = props.review;
    if (review && review.width > 0 && review.height > 0) {
      return { width: review.width, height: review.height };
    }
    return reviewVideoSize(sequence) ?? DEFAULT_VIDEO;
  }, [props.review, sequence]);
  const rect: Rect = useMemo(
    () => containRect(stage, videoSize),
    [stage, videoSize],
  );
  const frame = poseFrameAt(sequence, playheadMs);
  const heat = jointHeatAt(script, playheadMs);
  const phaseNow = currentStop(stops, playheadMs);
  const shownStop =
    (activeStopId !== null
      ? stops.find(stop => stop.id === activeStopId)
      : undefined) ??
    phaseNow ??
    null;
  const showArrow =
    shownStop !== null && (!playing || phaseNow?.id === shownStop.id);
  const arrow = showArrow
    ? arrowGeometry(rect, frame, script, shownStop)
    : null;
  const labelAnchor = arrow
    ? arrowLabelAnchor(rect, arrow.point, arrow.vector, arrow.unit)
    : null;
  const stopIndex = shownStop
    ? stops.findIndex(stop => stop.id === shownStop.id)
    : -1;
  const previousStop = stopIndex > 0 ? stops[stopIndex - 1] : undefined;
  const nextStop =
    stopIndex >= 0 && stopIndex < stops.length - 1
      ? stops[stopIndex + 1]
      : undefined;
  const fraction = (ms: number) =>
    durationMs > 0 ? clamp01(ms / durationMs) : 0;

  // The engine's own priority checkpoint names the stop it leads: that card
  // reads PRIORITY FIX so the guide's thesis and the replay agree.
  const priorityKey = analysis.priorityFix?.checkpoint ?? null;
  const verdict = shownStop ? VERDICT[shownStop.verdict] : null;
  const verdictLabel =
    shownStop && verdict
      ? shownStop.verdict === 'fix' &&
        priorityKey !== null &&
        shownStop.checkpoints[0]?.key === priorityKey
        ? 'PRIORITY FIX'
        : verdict.label
      : '';

  // FIXED layout: a portrait clip gets as much height as the phone allows
  // while still reading as one card. FILL layout: no height at all — the
  // stage is `flex: 1` and its parent's flex column decides.
  const stageHeight =
    props.stageHeight ??
    Math.round(Math.min(560, Math.max(300, viewport.height * 0.52)));

  const onStageLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage(current =>
      current.width === width && current.height === height
        ? current
        : { width, height },
    );
  };

  const stageCaption = replayStageCaption(clip, sequence, clipUnreadable);

  return (
    <View style={fill ? styles.fill : undefined} testID="form-review-player">
      {/* ── Stage: real frames + exoskeleton + heat + arrow, and nothing
          else. One grouped accessibility element; a tap anywhere on it
          toggles playback, exactly like a video in Photos. ─────────────── */}
      <Pressable
        style={[styles.stage, fill ? styles.fill : { height: stageHeight }]}
        onLayout={onStageLayout}
        onPress={togglePlay}
        testID="form-review-stage"
        accessible
        accessibilityRole="button"
        accessibilityLabel={
          shownStop
            ? `Replay at ${formatClock(playheadMs)}, ${shownStop.title}. ${shownStop.headline}`
            : `Replay at ${formatClock(playheadMs)}`
        }
        accessibilityHint={playing ? 'Pauses the replay' : 'Plays the replay'}
      >
        {clip && !clipUnreadable ? (
          <ClipPlayer
            uri={clip.uri}
            {...(clip.posterUri !== undefined
              ? { posterUri: clip.posterUri }
              : {})}
            playing={playing}
            seekMs={seekMs}
            resizeMode="contain"
            rate={rate}
            onProgress={advanceTo}
            onLoad={loaded => {
              if (loaded > 0) setDurationMs(loaded);
            }}
            onEnd={finish}
            onError={() => setClipUnreadable(true)}
          />
        ) : null}
        <FormReviewOverlay
          rect={rect}
          frame={frame}
          heat={heat}
          script={script}
          activeStop={shownStop}
          showArrow={showArrow}
          reducedMotion={reduced}
        />
        {arrow && labelAnchor ? (
          <View
            pointerEvents="none"
            onLayout={event => {
              const { width, height } = event.nativeEvent.layout;
              setLabelSize(current =>
                current.width === width && current.height === height
                  ? current
                  : { width, height },
              );
            }}
            style={[
              styles.arrowLabel,
              {
                left: labelAnchor.x - labelSize.width / 2,
                top: labelAnchor.y - labelSize.height / 2,
                opacity: labelSize.width > 0 ? 1 : 0,
              },
            ]}
            testID="form-review-arrow-label"
          >
            <Text style={[type.micro, { color: color.onVolt }]}>
              {arrow.label.toUpperCase()}
            </Text>
          </View>
        ) : null}
        {/* Partial-evidence caption: what is (not) on this device. */}
        {stageCaption ? (
          <View style={styles.evidenceCaption} pointerEvents="none">
            <Text style={[type.caption, styles.evidenceCaptionText]}>
              {stageCaption}
            </Text>
          </View>
        ) : null}
      </Pressable>

      {/* ── Stop card: verdict · phase, counter, measured headline, cue.
          Fixed height (the cue reserves three lines) so the stage above
          never jumps when the stop changes; it stays while playing because
          it no longer covers the body. ──────────────────────────────────── */}
      <View
        style={styles.card}
        accessible
        accessibilityLabel={
          shownStop
            ? `${verdictLabel}, ${shownStop.title}, stop ${stopIndex + 1} of ${stops.length}. ${shownStop.headline}. ${shownStop.cue}`
            : 'No checkpoint at this moment'
        }
        testID="form-review-stop-card"
      >
        {shownStop && verdict ? (
          <>
            <View style={styles.cardHeader}>
              <View style={styles.verdictRow}>
                <View
                  style={[styles.verdictDot, { backgroundColor: verdict.tint }]}
                />
                <Text style={[type.micro, { color: verdict.tint }]}>
                  {verdictLabel}
                </Text>
                <Text style={[type.micro, styles.cardPhase]} numberOfLines={1}>
                  {` · ${shownStop.title.toUpperCase()}`}
                </Text>
              </View>
              <Text style={[type.micro, styles.stopCounter]}>
                {`STOP ${stopIndex + 1} OF ${stops.length}`}
              </Text>
            </View>
            <Text style={[type.caption, styles.cardHeadline]} numberOfLines={1}>
              {shownStop.headline}
            </Text>
            <Text style={[type.body, styles.cardCue]}>{shownStop.cue}</Text>
          </>
        ) : null}
      </View>

      {/* ── Timeline: scrubber with checkpoint markers, then the clock ──── */}
      <View style={styles.timelineRow}>
        <View
          accessible
          accessibilityLabel="Review timeline"
          accessibilityHint="Drag to move through the clip; dots mark measured checkpoints"
          onLayout={event => setTrackWidth(event.nativeEvent.layout.width)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={seekToX}
          onResponderMove={seekToX}
          onResponderRelease={endScrub}
          onResponderTerminate={endScrub}
          style={styles.track}
          testID="form-review-timeline"
        >
          <View style={styles.trackBand} pointerEvents="none">
            <View
              style={[
                styles.trackPlayed,
                { width: `${fraction(playheadMs) * 100}%` },
              ]}
            />
          </View>
          {stops.map(stop => (
            <View
              key={stop.id}
              pointerEvents="none"
              style={[
                styles.stopMarker,
                {
                  left: `${fraction(stop.atMs) * 100}%`,
                  backgroundColor: VERDICT[stop.verdict].tint,
                  borderColor:
                    shownStop?.id === stop.id
                      ? color.onDark
                      : color.surfaceDark,
                },
              ]}
            />
          ))}
          <View
            pointerEvents="none"
            style={[
              styles.playhead,
              { left: `${fraction(playheadMs) * 100}%` },
            ]}
          />
        </View>
        <Text style={[type.caption, styles.clock]}>
          {formatClock(playheadMs)}
        </Text>
      </View>

      {/* ── Transport, symmetric around play: speed · prev · play · next ·
          AUTO. The two outer chips are the same size so the row balances. ── */}
      <View style={styles.controls}>
        <PressableScale
          onPress={() =>
            setSpeedIndex(current => (current + 1) % REVIEW_SPEEDS.length)
          }
          accessibilityLabel="Playback speed"
          accessibilityHint={`Currently ${speedLabel(rate)}. Tap to change.`}
          containerStyle={styles.chipContainer}
          style={styles.chip}
          testID="form-review-speed"
        >
          <Text
            style={[
              type.caption,
              styles.speedLabel,
              rate !== 1 && styles.speedLabelActive,
            ]}
          >
            {speedLabel(rate)}
          </Text>
        </PressableScale>
        <PressableScale
          onPress={() =>
            previousStop && jumpTo(previousStop.atMs, previousStop.id)
          }
          disabled={!previousStop}
          accessibilityLabel="Previous checkpoint"
          containerStyle={styles.chipContainer}
          style={styles.chip}
          testID="form-review-prev-stop"
        >
          <View style={styles.flipped}>
            <Icon name="chevron" size={20} color={color.onDark} />
          </View>
        </PressableScale>
        <PressableScale
          onPress={togglePlay}
          accessibilityLabel={playing ? 'Pause replay' : 'Play replay'}
          containerStyle={styles.playContainer}
          style={styles.playButton}
          testID="form-review-play"
        >
          <Icon
            name={playing ? 'pause' : 'play'}
            size={26}
            color={color.onVolt}
          />
        </PressableScale>
        <PressableScale
          onPress={() => nextStop && jumpTo(nextStop.atMs, nextStop.id)}
          disabled={!nextStop}
          accessibilityLabel="Next checkpoint"
          containerStyle={styles.chipContainer}
          style={styles.chip}
          testID="form-review-next-stop"
        >
          <Icon name="chevron" size={20} color={color.onDark} />
        </PressableScale>
        <PressableScale
          onPress={() => setAutoPause(current => !current)}
          accessibilityRole="switch"
          accessibilityLabel="Auto-pause at checkpoints"
          accessibilityState={{ checked: autoPause }}
          containerStyle={styles.chipContainer}
          style={[styles.chip, autoPause && styles.chipOn]}
          testID="form-review-autopause"
        >
          <Text
            style={[
              type.micro,
              { color: autoPause ? color.onVolt : color.onDarkMuted },
            ]}
          >
            AUTO
          </Text>
        </PressableScale>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  stage: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.cameraSurface,
  },
  arrowLabel: {
    position: 'absolute',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.volt,
  },
  evidenceCaption: {
    position: 'absolute',
    top: 12,
    left: 12,
    right: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: color.overlayDark,
  },
  evidenceCaptionText: { color: color.onDarkMuted },
  // ── Stop card (under the stage, never over the body) ──
  card: { marginTop: space.md },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: type.micro.lineHeight,
  },
  verdictRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  verdictDot: { width: 6, height: 6, borderRadius: 3 },
  cardPhase: { color: color.onDarkSubtle, flexShrink: 1 },
  stopCounter: {
    color: color.onDarkSubtle,
    flexShrink: 0,
    fontVariant: ['tabular-nums'],
  },
  cardHeadline: {
    color: color.onDarkMuted,
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  cardCue: { color: color.onDark, marginTop: 6, minHeight: CUE_MIN_HEIGHT },
  // ── Timeline ──
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.sm,
  },
  track: {
    flex: 1,
    height: TRACK_HEIGHT,
    justifyContent: 'center',
  },
  trackBand: {
    height: TRACK_BAND_HEIGHT,
    borderRadius: TRACK_BAND_HEIGHT / 2,
    backgroundColor: color.onDarkTint,
    overflow: 'hidden',
  },
  trackPlayed: { height: '100%', backgroundColor: color.onDarkMuted },
  stopMarker: {
    position: 'absolute',
    top: (TRACK_HEIGHT - STOP_MARKER) / 2,
    width: STOP_MARKER,
    height: STOP_MARKER,
    marginLeft: -STOP_MARKER / 2,
    borderRadius: STOP_MARKER / 2,
    borderWidth: 1.5,
  },
  playhead: {
    position: 'absolute',
    top: (TRACK_HEIGHT - PLAYHEAD_KNOB) / 2,
    width: PLAYHEAD_KNOB,
    height: PLAYHEAD_KNOB,
    marginLeft: -PLAYHEAD_KNOB / 2,
    borderRadius: PLAYHEAD_KNOB / 2,
    backgroundColor: color.onDark,
  },
  clock: {
    color: color.onDarkMuted,
    minWidth: 44,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  // ── Transport ──
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    marginTop: space.sm,
  },
  chipContainer: { width: 44 },
  chip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: color.volt, borderColor: color.volt },
  flipped: { transform: [{ scaleX: -1 }] },
  playContainer: { width: 56 },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedLabel: { color: color.onDark, fontVariant: ['tabular-nums'] },
  speedLabelActive: { color: color.volt },
});
