import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { PhaseKey, PhaseSpan, ShotAnalysis } from '@pickle/shared-types';
import {
  Button,
  Card,
  ErrorState,
  LoadingState,
  PressableScale,
  ScreenHeader,
  useReducedMotion,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import type { RootStackParams } from '../navigation/params';
import { ClipPlayer, clipPlaybackAvailable } from '../components/ClipPlayer';
import type { StrokeResultClip } from '../components/StrokeResult';
import {
  loadStrokeResultEvidence,
  type StrokeReviewEvidence,
} from '../components/strokeResultData';
import type { StrokeResultEvidenceRecord } from '../components/strokeResultModel';
import {
  PHASE_TITLES,
  buildFormReviewScript,
  jointHeatAt,
  poseFrameAt,
  reviewVideoSize,
  type FormReviewScript,
  type ReviewPoseSequence,
  type ReviewStop,
  type StopVerdict,
} from '../review/formReviewModel';
import {
  REVIEW_SPEEDS,
  clamp01,
  containRect,
  currentStop,
  nextAutoPause,
  speedLabel,
  type Rect,
} from '../review/formReviewGeometry';
import {
  FormReviewOverlay,
  arrowGeometry,
  arrowLabelAnchor,
} from '../review/FormReviewOverlay';
import { loadReviewPoseSequence } from '../review/poseSidecar';
import { armTryAgain, tryAgainFromResult } from './tryAgainHandoff';

/**
 * FORM REVIEW — the flagship post-analysis replay. The captured clip plays
 * back with the recorded pose drawn as an exoskeleton, a translucent heat map
 * over the joints the scored faults were measured from, and an arrow on the
 * joint that needs to move. Playback pauses itself at every measured
 * checkpoint moment with the coaching card for that stop.
 *
 * Honesty contract: everything shown traces to the analysis record and the
 * hash-verified pose sidecar. A missing clip shows the pose alone; a missing
 * or corrupt sidecar shows the clip alone; nothing is interpolated or
 * invented to fill either gap.
 */

type LoadState =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | {
      kind: 'ready';
      analysis: ShotAnalysis;
      record: StrokeResultEvidenceRecord | null;
      clip: StrokeResultClip | null;
      review: StrokeReviewEvidence | null;
      sequence: ReviewPoseSequence | null;
      script: FormReviewScript;
    };

/** Phase colors from the palette only — the legend and card name the phase,
 * so color is never the sole carrier. */
const PHASE_COLOR: Record<PhaseKey, string> = {
  ready: color.court,
  prepare: color.mint,
  accelerate: color.volt,
  contact: color.onDark,
  follow_through: color.flame,
  recover: color.court,
};

const VERDICT: Record<
  StopVerdict,
  { label: string; bg: string; fg: string; marker: string }
> = {
  fix: { label: 'FIX', bg: color.flame, fg: color.onVolt, marker: color.flame },
  watch: {
    label: 'WATCH',
    bg: color.volt,
    fg: color.onVolt,
    marker: color.volt,
  },
  strong: {
    label: 'STRONG',
    bg: color.mint,
    fg: color.onVolt,
    marker: color.mint,
  },
};

/** Fallback stage aspect (portrait phone capture) when nothing recorded a size. */
const DEFAULT_VIDEO = { width: 9, height: 16 };
const TICK_MS = 1000 / 30;
const END_TOLERANCE_MS = 30;
const EXTENT_PAD_MS = 250;

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatClock(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

/** Stored records are unvalidated JSON: an unknown phase key still gets a
 * readable label and the neutral court color rather than a crash. */
function phaseTitle(key: string): string {
  return (
    (PHASE_TITLES as Partial<Record<string, string>>)[key] ??
    key.replace(/_/g, ' ')
  );
}

function phaseColor(key: string): string {
  return (PHASE_COLOR as Partial<Record<string, string>>)[key] ?? color.court;
}

function measuredPhases(analysis: ShotAnalysis): PhaseSpan[] {
  const raw = Array.isArray(analysis.phases) ? analysis.phases : [];
  return raw.filter(
    phase => phase && finite(phase.startMs) && finite(phase.endMs),
  );
}

/** The measured phase spanning t (nearest representative on overlaps). */
function phaseAt(phases: readonly PhaseSpan[], t: number): PhaseSpan | null {
  let best: PhaseSpan | null = null;
  for (const phase of phases) {
    if (!phase || !finite(phase.startMs) || !finite(phase.endMs)) continue;
    if (t < phase.startMs || t > phase.endMs) continue;
    if (
      best === null ||
      Math.abs(phase.representativeMs - t) < Math.abs(best.representativeMs - t)
    ) {
      best = phase;
    }
  }
  return best;
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

export function FormReviewScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'FormReview'>>();
  const analysisId = route.params.analysisId;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      const evidence = await loadStrokeResultEvidence(
        getDb(),
        analysisId,
      ).catch(() => null);
      const analysis = evidence?.analysis ?? evidence?.record?.result ?? null;
      if (!analysis) {
        if (!cancelled) setState({ kind: 'missing' });
        return;
      }
      // The sidecar is read and hash-verified exactly like the engine does;
      // any failure is an honest null (pose-less replay), never a repair.
      const sidecar = evidence?.review?.poseSequence ?? null;
      const sequence = sidecar
        ? await loadReviewPoseSequence(sidecar).catch(() => null)
        : null;
      if (cancelled) return;
      setState({
        kind: 'ready',
        analysis,
        record: evidence?.record ?? null,
        clip: evidence?.clip ?? null,
        review: evidence?.review ?? null,
        sequence,
        script: buildFormReviewScript(analysis, sequence),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [analysisId]);

  if (state.kind === 'loading') {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="light-content" />
        <ScreenHeader
          title="Form review"
          dark
          onClose={() => navigation.goBack()}
        />
        <LoadingState label="Preparing your form review…" dark />
      </SafeAreaView>
    );
  }
  if (state.kind === 'missing') {
    return (
      <ErrorState
        title="Review unavailable"
        detail="This stroke has no scored analysis on this device, so there is nothing to replay."
        onRetry={() => navigation.goBack()}
        dark
      />
    );
  }
  // A "See it in your form review" link names the phase it wants: open the
  // replay frozen on that stop (only when the script actually has one there).
  const requestedPhase = route.params.phase;
  const initialStop =
    requestedPhase !== undefined
      ? (state.script.stops.find(stop => stop.phase === requestedPhase) ?? null)
      : null;
  return (
    <FormReviewBody
      key={analysisId}
      analysis={state.analysis}
      record={state.record}
      clip={state.clip}
      review={state.review}
      sequence={state.sequence}
      script={state.script}
      initialStop={initialStop}
      onClose={() => navigation.goBack()}
      onReanalyze={() => {
        // Same re-arm as the Result screen's TRY AGAIN: the guided camera
        // opens with this stroke's declaration (or AUTO) and practice set.
        armTryAgain(tryAgainFromResult(state.record, state.analysis));
        navigation.navigate('Analyze', { source: 'camera' });
      }}
    />
  );
}

// ─── The replay ─────────────────────────────────────────────────────────────

function FormReviewBody(props: {
  analysis: ShotAnalysis;
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
  review: StrokeReviewEvidence | null;
  sequence: ReviewPoseSequence | null;
  script: FormReviewScript;
  /** Open frozen on this stop (deep link from "See it in your form review"). */
  initialStop?: ReviewStop | null;
  onClose: () => void;
  onReanalyze: () => void;
}) {
  const { analysis, clip, sequence, script } = props;
  const stops = script.stops;
  const initialStop = props.initialStop ?? null;
  const reduced = useReducedMotion();
  const viewport = useWindowDimensions();

  // Real frames when the native player exists for this build and a clip
  // file is stored; otherwise a JS clock drives the measured pose alone.
  const nativeDriven = clip !== null && clipPlaybackAvailable();

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

  /** Freeze on a checkpoint frame and show its card. */
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
  const phases = useMemo(() => measuredPhases(analysis), [analysis]);
  const measuredPhase = phaseAt(phases, playheadMs);
  const phaseLabel = measuredPhase
    ? phaseTitle(measuredPhase.key).toUpperCase()
    : 'OUTSIDE STROKE';
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
  // The stage is the product: give a portrait clip as much height as the
  // phone allows while the timeline still starts above the fold (the stop
  // card scrolls into view on the first pause).
  const stageHeight = Math.round(
    Math.min(560, Math.max(300, viewport.height * 0.52)),
  );

  const onStageLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setStage(current =>
      current.width === width && current.height === height
        ? current
        : { width, height },
    );
  };

  const stageCaption =
    clip === null
      ? sequence
        ? 'The clip file is gone from this device; the measured pose is shown instead.'
        : 'No clip file or recorded pose is stored for this stroke on this device. The checkpoints below are still the ones the engine scored.'
      : sequence === null
        ? 'No verified pose sequence is stored for this clip, so the replay shows the video without an exoskeleton.'
        : null;

  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={styles.screen}
      testID="form-review-screen"
    >
      <StatusBar barStyle="light-content" />
      <ScreenHeader
        title="Form review"
        dark
        onClose={props.onClose}
        right={
          <PressableScale
            onPress={() =>
              setSpeedIndex(current => (current + 1) % REVIEW_SPEEDS.length)
            }
            accessibilityLabel="Playback speed"
            accessibilityHint={`Currently ${speedLabel(rate)}. Tap to change.`}
            containerStyle={styles.speedContainer}
            style={styles.speedChip}
            testID="form-review-speed"
          >
            <Text style={[type.caption, styles.speedLabel]}>
              {speedLabel(rate)}
            </Text>
          </PressableScale>
        }
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Stage: real frames + exoskeleton + heat + arrow ─────────── */}
        <View
          style={[styles.stage, { height: stageHeight }]}
          onLayout={onStageLayout}
          testID="form-review-stage"
          accessible
          accessibilityLabel={
            shownStop
              ? `Replay at ${formatClock(playheadMs)}, ${shownStop.title}. ${shownStop.headline}`
              : `Replay at ${formatClock(playheadMs)}`
          }
        >
          {clip ? (
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
          <View
            style={[styles.stageChip, styles.phaseChip]}
            pointerEvents="none"
          >
            <Text style={[type.micro, { color: color.onDark }]}>
              {phaseLabel}
            </Text>
          </View>
          <View
            style={[styles.stageChip, styles.clockChip]}
            pointerEvents="none"
          >
            <Text style={[type.micro, styles.clock]}>
              {formatClock(playheadMs)}
            </Text>
          </View>
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
        </View>
        {stageCaption ? (
          <Text style={[type.caption, styles.stageCaption]}>
            {stageCaption}
          </Text>
        ) : null}

        {/* ── Timeline: measured phases, checkpoint markers, playhead ─── */}
        <View
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
          {phases.map(phase => (
            <View
              key={`${phase.key}-${phase.startMs}`}
              style={[
                styles.phaseSegment,
                {
                  left: `${fraction(phase.startMs) * 100}%`,
                  width: `${Math.max(
                    0.5,
                    (fraction(phase.endMs) - fraction(phase.startMs)) * 100,
                  )}%`,
                  backgroundColor: phaseColor(phase.key),
                },
              ]}
            />
          ))}
          {stops.map(stop => (
            <View
              key={stop.id}
              style={[
                styles.stopMarker,
                {
                  left: `${fraction(stop.atMs) * 100}%`,
                  backgroundColor: VERDICT[stop.verdict].marker,
                  borderColor:
                    shownStop?.id === stop.id
                      ? color.onDark
                      : color.surfaceDark,
                },
              ]}
            />
          ))}
          <View
            style={[
              styles.playhead,
              { left: `${fraction(playheadMs) * 100}%` },
            ]}
          />
        </View>
        <View style={styles.legend} accessibilityLabel="Timeline legend">
          {phases.map(phase => (
            <View
              key={`legend-${phase.key}-${phase.startMs}`}
              style={styles.legendItem}
            >
              <View
                style={[
                  styles.legendDot,
                  { backgroundColor: phaseColor(phase.key) },
                ]}
              />
              <Text style={[type.micro, { color: color.onDarkMuted }]}>
                {phaseTitle(phase.key).toUpperCase()}
              </Text>
            </View>
          ))}
        </View>

        {/* ── Stop card: what was measured here and what to do ────────── */}
        {shownStop ? (
          <Card
            tone="dark"
            style={styles.stopCard}
            testID="form-review-stop-card"
          >
            <View style={styles.stopHeader}>
              <View
                style={[
                  styles.verdictPill,
                  { backgroundColor: VERDICT[shownStop.verdict].bg },
                ]}
              >
                <Text
                  style={[type.micro, { color: VERDICT[shownStop.verdict].fg }]}
                >
                  {VERDICT[shownStop.verdict].label}
                </Text>
              </View>
              <Text style={[type.micro, styles.stopCounter]}>
                {`STOP ${stopIndex + 1} OF ${stops.length}`}
              </Text>
            </View>
            <Text style={[type.h3, styles.stopTitle]}>{shownStop.title}</Text>
            <Text style={[type.caption, styles.stopCheckpoint]}>
              {shownStop.checkpoints[0]
                ? `${shownStop.checkpoints[0].name} · ${Math.round(
                    shownStop.checkpoints[0].score,
                  )} / 100`
                : 'Wrist-speed peak · no checkpoint scored here'}
            </Text>
            <Text style={[type.bodyBold, styles.stopHeadline]}>
              {shownStop.headline}
            </Text>
            <Text style={[type.micro, styles.cueLabel]}>COACHING CUE</Text>
            <Text style={[type.body, styles.cue]}>{shownStop.cue}</Text>

            <View style={styles.controls}>
              <PressableScale
                onPress={() =>
                  previousStop && jumpTo(previousStop.atMs, previousStop.id)
                }
                disabled={!previousStop}
                accessibilityLabel="Previous checkpoint"
                containerStyle={styles.stepContainer}
                style={styles.stepButton}
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
                  size={24}
                  color={color.onVolt}
                />
              </PressableScale>
              <PressableScale
                onPress={() => nextStop && jumpTo(nextStop.atMs, nextStop.id)}
                disabled={!nextStop}
                accessibilityLabel="Next checkpoint"
                containerStyle={styles.stepContainer}
                style={styles.stepButton}
                testID="form-review-next-stop"
              >
                <Icon name="chevron" size={20} color={color.onDark} />
              </PressableScale>
              <PressableScale
                onPress={() => setAutoPause(current => !current)}
                accessibilityRole="switch"
                accessibilityLabel="Auto-pause at checkpoints"
                accessibilityState={{ checked: autoPause }}
                containerStyle={styles.autoPauseContainer}
                style={[styles.autoPause, autoPause && styles.autoPauseOn]}
                testID="form-review-autopause"
              >
                <Text
                  style={[
                    type.micro,
                    { color: autoPause ? color.onVolt : color.onDarkMuted },
                  ]}
                >
                  {autoPause ? 'AUTO-PAUSE ON' : 'AUTO-PAUSE OFF'}
                </Text>
              </PressableScale>
            </View>
          </Card>
        ) : null}

        {/* ── CTAs ────────────────────────────────────────────────────── */}
        <View style={styles.ctaRow}>
          <Button
            label="Re-analyze this stroke"
            variant="volt"
            icon="camera"
            onPress={props.onReanalyze}
            testID="form-review-reanalyze"
          />
          <Button
            label="Back to results"
            variant="dark"
            onPress={props.onClose}
            testID="form-review-back"
          />
        </View>
        <Text style={[type.caption, styles.disclosure]}>
          Replay, pose and scoring stay on this device — the clip is never
          uploaded.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  content: { paddingHorizontal: space.lg, paddingBottom: space.xl },
  speedContainer: { width: 44, alignSelf: 'center' },
  speedChip: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedLabel: { color: color.volt, fontVariant: ['tabular-nums'] },
  stage: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.cameraSurface,
  },
  stageChip: {
    position: 'absolute',
    top: 12,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.overlayDeep,
  },
  phaseChip: { left: 12 },
  clockChip: { right: 12 },
  clock: { color: color.onDark, fontVariant: ['tabular-nums'] },
  arrowLabel: {
    position: 'absolute',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: color.volt,
  },
  stageCaption: { color: color.onDarkSubtle, marginTop: space.sm },
  track: {
    height: 44,
    marginTop: space.md,
    borderRadius: radius.xs,
    backgroundColor: color.inkElevated,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  phaseSegment: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    opacity: 0.55,
  },
  stopMarker: {
    position: 'absolute',
    width: 10,
    height: 10,
    marginLeft: -5,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  playhead: {
    position: 'absolute',
    top: 2,
    bottom: 2,
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: color.onDark,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    marginTop: space.sm,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 7, height: 7, borderRadius: 4 },
  stopCard: { marginTop: space.md, padding: space.lg },
  stopHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  verdictPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  stopCounter: { color: color.onDarkSubtle, fontVariant: ['tabular-nums'] },
  stopTitle: { color: color.onDark, marginTop: space.md },
  stopCheckpoint: {
    color: color.onDarkMuted,
    marginTop: space.xxs,
    fontVariant: ['tabular-nums'],
  },
  stopHeadline: { color: color.onDark, marginTop: space.md },
  cueLabel: { color: color.volt, marginTop: space.md },
  cue: { color: color.onDarkMuted, marginTop: space.xs },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.lg,
  },
  stepContainer: { width: 44 },
  stepButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceDark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  autoPauseContainer: { flex: 1, alignItems: 'flex-end' },
  autoPause: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.lineDark,
    justifyContent: 'center',
  },
  autoPauseOn: { backgroundColor: color.volt, borderColor: color.volt },
  ctaRow: { gap: 10, marginTop: space.xl },
  disclosure: {
    color: color.onDarkFaint,
    marginTop: space.md,
    textAlign: 'center',
  },
});
