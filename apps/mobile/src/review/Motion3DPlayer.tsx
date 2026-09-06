import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  UIManager,
  View,
  requireNativeComponent,
  useWindowDimensions,
  type GestureResponderEvent,
  type ViewProps,
} from 'react-native';
import type { Motion3DArtifact } from '@pickle/swing-domain';
import {
  MOTION_3D_ANGLE_JOINTS,
  motion3DAngle,
} from '@pickle/analysis-pipeline';
import { useReducedMotion } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import {
  MOTION_REVIEW_SPEEDS,
  motionFrameDescription,
  motionReviewClock,
  motionReviewError,
  motionReviewSeek,
  motionScaleDescription,
  readMotionReviewProgress,
  readMotionReviewReady,
  type MotionReviewAction,
  type MotionReviewCommand,
  type MotionReviewProgress,
  type MotionReviewReady,
} from './motion3dReviewModel';

export interface Motion3DPlayerProps {
  artifact: Motion3DArtifact;
  artifactJson: string;
  artifactSha256: string;
  videoUri: string;
  fill?: boolean;
}

interface NativeMotionReviewProps extends ViewProps {
  artifactJson: string;
  artifactSha256: string;
  videoUri: string;
  command: MotionReviewCommand | null;
  onReviewReady: (event: { nativeEvent: unknown }) => void;
  onReviewProgress: (event: { nativeEvent: unknown }) => void;
  onReviewError: (event: {
    nativeEvent: { artifactSha256: string; code: string };
  }) => void;
}

const NATIVE_COMPONENT = 'PickleMotionReviewView';
const NativeMotionReview = (() => {
  const version = Number.parseInt(String(Platform.Version), 10);
  if (Platform.OS !== 'ios' || !Number.isFinite(version) || version < 17)
    return null;
  try {
    return UIManager.getViewManagerConfig?.(NATIVE_COMPONENT) != null
      ? requireNativeComponent<NativeMotionReviewProps>(NATIVE_COMPONENT)
      : null;
  } catch {
    return null;
  }
})();

export function motion3DPlaybackAvailable(): boolean {
  return NativeMotionReview !== null;
}

export function Motion3DPlayer(props: Motion3DPlayerProps) {
  return (
    <Motion3DPlayerSession
      key={`${props.artifactSha256}:${props.videoUri}`}
      {...props}
    />
  );
}

function Motion3DPlayerSession({
  artifact,
  artifactJson,
  artifactSha256,
  videoUri,
  fill,
}: Motion3DPlayerProps) {
  const viewport = useWindowDimensions();
  const reduced = useReducedMotion();
  const [ready, setReady] = useState<MotionReviewReady | null>(null);
  const [progress, setProgress] = useState<MotionReviewProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<MotionReviewCommand | null>(null);
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const nextCommandID = useRef(0);
  const transportCommandID = useRef(-1);
  const readyRef = useRef<MotionReviewReady | null>(null);
  const playingIntent = useRef(false);
  const trackWidth = useRef(0);
  const lastScrub = useRef<number | null>(null);

  const send = useCallback((action: MotionReviewAction, value?: number) => {
    const id = ++nextCommandID.current;
    if (action === 'play') playingIntent.current = true;
    if (action === 'pause' || action === 'seek' || action === 'step')
      playingIntent.current = false;
    if (['play', 'pause', 'seek', 'step'].includes(action))
      transportCommandID.current = id;
    setCommand({
      id,
      action,
      ...(value === undefined ? {} : { value }),
    });
  }, []);

  useEffect(() => {
    readyRef.current = null;
    playingIntent.current = false;
    transportCommandID.current = -1;
    setEvidenceExpanded(false);
    setReady(null);
    setProgress(null);
    setError(null);
    setCommand(null);
  }, [artifactJson]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') send('pause');
    });
    return () => subscription.remove();
  }, [send]);

  useEffect(() => {
    if (reduced) send('pause');
  }, [reduced, send]);

  const onReady = useCallback(
    (event: { nativeEvent: unknown }) => {
      const value = readMotionReviewReady(
        event.nativeEvent,
        artifact,
        artifactSha256,
      );
      if (!value) {
        send('pause');
        setError(motionReviewError('invalid_artifact'));
        return;
      }
      readyRef.current = value;
      setReady(value);
      setError(null);
    },
    [artifact, artifactSha256, send],
  );

  const onProgress = useCallback(
    (event: { nativeEvent: unknown }) => {
      const loaded = readyRef.current;
      if (!loaded) return;
      const value = readMotionReviewProgress(
        event.nativeEvent,
        loaded.durationMs,
        artifactSha256,
      );
      if (!value || value.sourceState !== loaded.sourceState) return;
      if (value.commandId >= transportCommandID.current)
        playingIntent.current = value.playing;
      setProgress(value);
    },
    [artifactSha256],
  );

  const onError = useCallback(
    (event: { nativeEvent: { artifactSha256: string; code: string } }) => {
      if (event.nativeEvent.artifactSha256 !== artifactSha256) return;
      readyRef.current = null;
      playingIntent.current = false;
      setReady(null);
      setProgress(null);
      setError(motionReviewError(event.nativeEvent.code));
    },
    [artifactSha256],
  );

  const durationMs = ready?.durationMs ?? artifact.source.durationMs;
  const positionMs = progress?.positionMs ?? 0;
  const rate = progress?.rate ?? 1;
  const mode = progress?.mode ?? 'motion';
  const playing = progress?.playing === true;
  const disabled = !ready || error !== null || !NativeMotionReview;
  const previousDisabled =
    disabled || !(progress?.canStepBackward ?? positionMs > 0);
  const nextDisabled =
    disabled || !(progress?.canStepForward ?? positionMs < durationMs);
  const recordingAvailable = ready?.sourceState === 'verified';
  const sourceOnly = ready?.clock === 'pose_only';
  const stageHeight = Math.round(
    Math.max(200, Math.min(400, viewport.height * 0.4)),
  );
  const fraction =
    durationMs > 0 ? Math.max(0, Math.min(1, positionMs / durationMs)) : 0;

  const seekFromTouch = (event: GestureResponderEvent) => {
    if (disabled) return;
    const value = motionReviewSeek(
      event.nativeEvent.locationX,
      trackWidth.current,
      durationMs,
    );
    if (value !== null) {
      lastScrub.current = value;
      send('seek', value);
    }
  };

  const frameLabel = sourceOnly ? 'sampled frame' : 'source frame';
  const cameraDisabled = disabled || mode !== 'motion';
  const framesByIndex = useMemo(
    () => new Map(artifact.frames.map(frame => [frame.frameIndex, frame])),
    [artifact],
  );
  const angleFrame =
    !progress?.seeking &&
    progress?.frameStatus === 'estimated' &&
    progress.frameIndex !== null
      ? (framesByIndex.get(progress.frameIndex) ?? null)
      : null;

  return (
    <View
      testID="motion3d-player"
      style={[
        styles.player,
        fill ? styles.fill : { height: Math.max(420, viewport.height * 0.88) },
      ]}
    >
      <ScrollView
        testID="motion3d-information"
        style={styles.information}
        contentContainerStyle={styles.informationContent}
        showsVerticalScrollIndicator
      >
        <View style={styles.heading}>
          <Text style={[type.h3, styles.chalk]}>3D motion</Text>
          <Text style={[type.body, styles.subtitle]}>
            Estimated from your recording
          </Text>
        </View>
        <View style={styles.modeRow} testID="motion3d-mode-controls">
          <Pressable
            testID="motion3d-mode-motion"
            accessibilityRole="button"
            accessibilityLabel="Show estimated 3D motion"
            accessibilityState={{ selected: mode === 'motion', disabled }}
            disabled={disabled}
            onPress={() => send('motion')}
            style={[
              styles.modeButton,
              mode === 'motion' && styles.selectedButton,
              disabled && styles.disabled,
            ]}
          >
            <Text
              style={[
                type.caption,
                mode === 'motion' ? styles.voltText : styles.chalk,
              ]}
            >
              3D motion
            </Text>
          </Pressable>
          <Pressable
            testID="motion3d-mode-recording"
            accessibilityRole="button"
            accessibilityLabel="Show raw recording"
            accessibilityHint="Uses the same native playback position as the 3D motion."
            accessibilityState={{
              selected: mode === 'recording',
              disabled: disabled || !recordingAvailable,
            }}
            disabled={disabled || !recordingAvailable}
            onPress={() => send('recording')}
            style={[
              styles.modeButton,
              mode === 'recording' && styles.selectedButton,
              (disabled || !recordingAvailable) && styles.disabled,
            ]}
          >
            <Text
              style={[
                type.caption,
                mode === 'recording' ? styles.voltText : styles.chalk,
              ]}
            >
              Recording
            </Text>
          </Pressable>
        </View>
        <View
          testID="motion3d-stage"
          accessible
          accessibilityRole="image"
          accessibilityLabel={
            mode === 'motion'
              ? 'Estimated 3D surface, not a body scan'
              : 'Raw recording'
          }
          accessibilityHint={
            mode === 'motion'
              ? 'Drag within the scene to turn. Pinch to zoom. Turn, zoom and reset buttons follow the scene.'
              : undefined
          }
          style={[styles.stage, { height: stageHeight }]}
        >
          {NativeMotionReview && error === null ? (
            <NativeMotionReview
              testID="motion3d-native"
              artifactJson={artifactJson}
              artifactSha256={artifactSha256}
              videoUri={videoUri}
              command={command}
              onReviewReady={onReady}
              onReviewProgress={onProgress}
              onReviewError={onError}
              style={StyleSheet.absoluteFill}
              accessible={false}
            />
          ) : null}
        </View>
        <View testID="motion3d-camera-controls" style={styles.cameraRow}>
          {(
            [
              ['turnLeft', 'Turn left'],
              ['turnRight', 'Turn right'],
              ['zoomOut', 'Zoom out'],
              ['zoomIn', 'Zoom in'],
              ['reset', 'Reset view'],
            ] as const
          ).map(([action, label]) => (
            <Pressable
              key={action}
              testID={`motion3d-${action}`}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityState={{ disabled: cameraDisabled }}
              disabled={cameraDisabled}
              onPress={() => send(action)}
              style={[styles.cameraButton, cameraDisabled && styles.disabled]}
            >
              <Text style={[type.caption, styles.chalk]}>{label}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.notes} testID="motion3d-evidence-state">
          {!NativeMotionReview ? (
            <Text style={[type.body, styles.chalk]}>
              3D motion playback requires iOS 17 or later and a build with the
              native review player.
            </Text>
          ) : error ? (
            <Text accessibilityRole="alert" style={[type.body, styles.chalk]}>
              {error}
            </Text>
          ) : !ready ? (
            <Text style={[type.body, styles.chalk]}>
              Checking the 3D record and private recording…
            </Text>
          ) : (
            <>
              {sourceOnly ? (
                <Text
                  style={[type.body, styles.chalk]}
                  testID="motion3d-pose-only"
                >
                  Recording missing. Pose-only playback uses a native clock;
                  video synchronization cannot be checked.
                </Text>
              ) : null}
              <Text
                testID="motion3d-frame-state"
                style={[type.caption, styles.chalk]}
              >
                {motionFrameDescription(progress)}
              </Text>
            </>
          )}
          <Text
            testID="motion3d-development-disclosure"
            style={[type.caption, styles.muted]}
          >
            Development estimate. Not a body scan.
          </Text>
          <Pressable
            testID="motion3d-evidence-toggle"
            accessibilityRole="button"
            accessibilityLabel="Evidence and limitations"
            accessibilityState={{ expanded: evidenceExpanded }}
            onPress={() => setEvidenceExpanded(value => !value)}
            style={styles.evidenceButton}
          >
            <Text style={[type.caption, styles.chalk]}>
              {evidenceExpanded ? 'Hide evidence' : 'Evidence'}
            </Text>
          </Pressable>
          {evidenceExpanded ? (
            <View
              testID="motion3d-evidence-details"
              style={styles.evidenceDetails}
            >
              <Text style={[type.bodyBold, styles.chalk]}>
                Estimated joint angles
              </Text>
              <Text style={[type.caption, styles.muted]}>
                {angleFrame
                  ? `Pose sample at ${motionReviewClock(angleFrame.timestampMs)}. Inside angles, not technique ratings.`
                  : 'No supported joint-angle sample at this time.'}
              </Text>
              {MOTION_3D_ANGLE_JOINTS.map(joint => {
                const angle = angleFrame
                  ? motion3DAngle(angleFrame, joint)
                  : null;
                const label = joint.replace(/_/g, ' ');
                return (
                  <Text
                    key={joint}
                    testID={`motion3d-angle-${joint}`}
                    style={[type.caption, styles.chalk]}
                  >
                    {label[0]!.toUpperCase() + label.slice(1)}:{' '}
                    {angle === null ? '—' : `${Math.round(angle)}°`}
                  </Text>
                );
              })}
              <Text style={[type.caption, styles.muted]}>
                This build supports one visible person. It does not verify
                identity or track bystanders.
              </Text>
              <Text style={[type.caption, styles.muted]}>
                Accuracy has not been independently validated. Joint confidence
                is unavailable; missing joints and gaps are not filled.
              </Text>
              <Text style={[type.caption, styles.muted]}>
                Raw root-relative estimates with fixed camera framing across the
                sequence.{' '}
                {ready ? motionScaleDescription(ready.scaleBasis) : ''}
              </Text>
              {sourceOnly ? (
                <Text style={[type.caption, styles.muted]}>
                  Without the recording, frame buttons step through stored
                  samples on a native clock.
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
      <View style={styles.footer} testID="motion3d-transport">
        <View style={styles.clockRow}>
          <Text style={[type.caption, styles.chalk]}>
            {motionReviewClock(positionMs)}
          </Text>
          <Text style={[type.caption, styles.muted]}>
            {motionReviewClock(durationMs)}
          </Text>
        </View>
        <View
          testID="motion3d-timeline"
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Motion timeline"
          accessibilityHint={`Drag to seek. Accessibility adjustments move one ${frameLabel}. Seeking pauses playback.`}
          accessibilityState={{ disabled }}
          accessibilityValue={{
            min: 0,
            max: durationMs,
            now: positionMs,
            text: `${motionReviewClock(positionMs)} of ${motionReviewClock(durationMs)}`,
          }}
          accessibilityActions={[
            { name: 'increment', label: `Next ${frameLabel}` },
            { name: 'decrement', label: `Previous ${frameLabel}` },
          ]}
          onAccessibilityAction={event => {
            if (disabled) return;
            if (event.nativeEvent.actionName === 'increment') send('step', 1);
            if (event.nativeEvent.actionName === 'decrement') send('step', -1);
          }}
          onLayout={event => {
            trackWidth.current = event.nativeEvent.layout.width;
          }}
          onStartShouldSetResponder={() => !disabled}
          onMoveShouldSetResponder={() => !disabled}
          onResponderGrant={seekFromTouch}
          onResponderMove={seekFromTouch}
          onResponderRelease={() => {
            if (lastScrub.current !== null) send('seek', lastScrub.current);
            lastScrub.current = null;
          }}
          onResponderTerminate={() => {
            lastScrub.current = null;
          }}
          style={[styles.timeline, disabled && styles.disabled]}
        >
          <View pointerEvents="none" style={styles.trackBand}>
            <View
              style={[styles.trackPlayed, { width: `${fraction * 100}%` }]}
            />
          </View>
          <View
            pointerEvents="none"
            style={[styles.knob, { left: `${fraction * 100}%` }]}
          />
        </View>
        <View style={styles.transportRow}>
          <Pressable
            testID="motion3d-speed"
            accessibilityRole="button"
            accessibilityLabel={`Playback speed ${rate} times`}
            accessibilityHint="Cycles through quarter, half and normal speed."
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() =>
              send(
                'rate',
                MOTION_REVIEW_SPEEDS[
                  (MOTION_REVIEW_SPEEDS.indexOf(rate) + 1) %
                    MOTION_REVIEW_SPEEDS.length
                ] ?? 1,
              )
            }
            style={[styles.speedButton, disabled && styles.disabled]}
          >
            <Text style={[type.caption, styles.chalk]}>{`${rate}×`}</Text>
          </Pressable>
          <Pressable
            testID="motion3d-previous"
            accessibilityRole="button"
            accessibilityLabel={`Previous ${frameLabel}`}
            accessibilityState={{ disabled: previousDisabled }}
            disabled={previousDisabled}
            onPress={() => send('step', -1)}
            style={[styles.iconButton, previousDisabled && styles.disabled]}
          >
            <View style={styles.reverse}>
              <Icon name="chevron" size={24} color={color.onDark} />
            </View>
          </Pressable>
          <Pressable
            testID="motion3d-play"
            accessibilityRole="button"
            accessibilityLabel={
              playing ? 'Pause motion playback' : 'Play motion playback'
            }
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => send(playingIntent.current ? 'pause' : 'play')}
            style={[styles.playButton, disabled && styles.disabled]}
          >
            <Icon
              name={playing ? 'pause' : 'play'}
              size={24}
              color={color.onVolt}
            />
          </Pressable>
          <Pressable
            testID="motion3d-next"
            accessibilityRole="button"
            accessibilityLabel={`Next ${frameLabel}`}
            accessibilityState={{
              disabled: nextDisabled,
            }}
            disabled={nextDisabled}
            onPress={() => send('step', 1)}
            style={[styles.iconButton, nextDisabled && styles.disabled]}
          >
            <Icon name="chevron" size={24} color={color.onDark} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  player: { backgroundColor: color.ink, minHeight: 0 },
  fill: { flex: 1 },
  information: { flex: 1, minHeight: 0 },
  informationContent: { paddingBottom: space.md },
  heading: {
    paddingHorizontal: space.md,
    paddingTop: space.md,
    paddingBottom: space.sm,
  },
  chalk: { color: color.onDark },
  muted: { color: color.onDarkMuted },
  voltText: { color: color.volt },
  subtitle: { color: color.onDarkMuted, marginTop: space.sm, maxWidth: 340 },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  modeButton: {
    minHeight: 44,
    minWidth: 100,
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.xs,
    backgroundColor: color.inkElevated,
  },
  selectedButton: { borderBottomWidth: 2, borderBottomColor: color.volt },
  stage: { backgroundColor: color.ink, overflow: 'hidden' },
  cameraRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
  },
  cameraButton: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    backgroundColor: color.inkElevated,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
  },
  notes: { padding: space.md, gap: space.sm },
  evidenceButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.xs,
    backgroundColor: color.inkElevated,
    alignSelf: 'flex-start',
  },
  evidenceDetails: { gap: space.sm },
  footer: {
    flexShrink: 0,
    backgroundColor: color.ink,
    borderTopWidth: 1,
    borderTopColor: color.lineDark,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: space.sm,
  },
  clockRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
    flexWrap: 'wrap',
  },
  timeline: {
    minHeight: 44,
    justifyContent: 'center',
    marginHorizontal: space.sm,
  },
  trackBand: {
    height: space.xs,
    backgroundColor: color.lineDark,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  trackPlayed: { height: space.xs, backgroundColor: color.onDarkMuted },
  knob: {
    position: 'absolute',
    width: space.md,
    height: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.volt,
    marginLeft: -space.sm,
  },
  transportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  iconButton: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.inkElevated,
  },
  speedButton: {
    minHeight: 44,
    minWidth: 64,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.xs,
    backgroundColor: color.inkElevated,
  },
  playButton: {
    minHeight: 56,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: color.volt,
  },
  reverse: { transform: [{ rotate: '180deg' }] },
  disabled: { opacity: 0.45 },
});
