import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { useReducedMotion } from '../design/components';
import { color, radius, space, type as typography } from '../design/tokens';
import {
  prepare3DComparison,
  project3DFrame,
  sample3DComparison,
  type Comparison3DInput,
  type Estimated3DSequence,
  type Frame3D,
  type Prepared3DComparison,
} from './experimental3DComparisonModel';

export interface Experimental3DComparisonProps {
  input?: Comparison3DInput | null;
  offlinePreview?: boolean;
}

const VIEWS = [
  { label: 'As supplied', yawDegrees: 0, pitchDegrees: 0 },
  { label: 'Turn 45°', yawDegrees: 45, pitchDegrees: 0 },
  { label: 'Tilt 20°', yawDegrees: 45, pitchDegrees: 20 },
] as const;

function Control(props: {
  label: string;
  accessibilityLabel?: string;
  hint?: string;
  testID: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  expanded?: boolean;
  primary?: boolean;
}) {
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.hint}
      accessibilityState={{
        disabled: !!props.disabled,
        selected: props.selected,
        expanded: props.expanded,
      }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.control,
        props.primary && styles.primary,
        props.selected && styles.selected,
        props.disabled && styles.disabled,
        pressed && !props.disabled && styles.pressed,
      ]}
    >
      <Text style={[styles.controlLabel, props.primary && styles.primaryLabel]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

function Panel(props: {
  id: 'user' | 'reference';
  title: string;
  tint: string;
  sequence: Estimated3DSequence;
  frame: Frame3D | null;
  model: Prepared3DComparison;
  viewIndex: number;
}) {
  const { frame, model, viewIndex, sequence, title, id, tint } = props;
  const geometry = useMemo(
    () =>
      frame
        ? project3DFrame(
            frame,
            model.input.bones,
            model.input.projection,
            VIEWS[viewIndex] ?? VIEWS[0],
          )
        : null,
    [frame, model, viewIndex],
  );
  return (
    <View style={styles.panel} testID={`comparison3d-${id}-panel`}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={
          frame
            ? `${title}. Estimated XYZ projection at original timestamp ${frame.timestampMs} milliseconds. Unobserved joints are omitted.`
            : `${title}. No paired XYZ evidence at this comparison time.`
        }
        testID={`comparison3d-${id}-stage`}
      >
        <Svg
          testID={`comparison3d-${id}-svg`}
          accessible={false}
          width="100%"
          height={208}
          viewBox="-1.2 -1.4 2.4 2.8"
        >
          {geometry?.map(primitive => {
            const depth = Math.max(0, Math.min(1, (primitive.depth + 1) / 2));
            const opacity = 0.55 + depth * 0.35;
            return primitive.kind === 'bone' ? (
              <Line
                key={`bone-${primitive.id}`}
                x1={primitive.from.x}
                y1={-primitive.from.y}
                x2={primitive.to.x}
                y2={-primitive.to.y}
                stroke={tint}
                strokeWidth={0.032 + depth * 0.008}
                strokeLinecap="round"
                opacity={opacity}
              />
            ) : (
              <Circle
                key={`joint-${primitive.id}`}
                cx={primitive.point.x}
                cy={-primitive.point.y}
                r={0.04 + depth * 0.008}
                fill={tint}
                stroke={color.inkElevated}
                strokeWidth={0.012}
                opacity={opacity}
              />
            );
          })}
        </Svg>
      </View>
      <Text style={styles.caption} testID={`comparison3d-${id}-timestamp`}>
        {frame ? `Original ${frame.timestampMs} ms` : 'No paired timestamp'}
      </Text>
      <Text style={styles.muted}>{sequence.provenance.description}</Text>
    </View>
  );
}

function OfflinePlayback({ model }: { model: Prepared3DComparison }) {
  const reduced = useReducedMotion();
  const [timeMs, setTimeMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [viewIndex, setViewIndex] = useState(0);
  const [details, setDetails] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const clock = useRef(0);
  const { user, reference, projection, alignment } = model.input;
  const duration = alignment.durationMs;
  const sample = sample3DComparison(model, timeMs);
  const softwareOnly = user.provenance.source === 'software-only-fixture';
  const stops = useMemo(
    () =>
      [
        ...new Set([
          0,
          ...alignment.intervals.flatMap(interval => [
            interval.startMs,
            interval.endMs,
          ]),
          duration,
        ]),
      ].sort((a, b) => a - b),
    [alignment, duration],
  );

  useEffect(() => {
    clock.current = 0;
    setTimeMs(0);
    setPlaying(false);
    setViewIndex(0);
  }, [model]);

  useEffect(() => {
    if (reduced) setPlaying(false);
  }, [reduced]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') setPlaying(false);
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!playing || reduced) return;
    const runtime = globalThis as typeof globalThis & {
      performance?: { now(): number };
    };
    const monotonic = runtime.performance;
    if (!monotonic) {
      setPlaying(false);
      return;
    }
    const started = monotonic.now();
    const from = clock.current;
    const timer = setInterval(() => {
      const next = Math.min(duration, from + monotonic.now() - started);
      clock.current = next;
      setTimeMs(next);
      if (next >= duration) setPlaying(false);
    }, 40);
    return () => clearInterval(timer);
  }, [duration, model, playing, reduced]);

  const seek = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) return;
      setPlaying(false);
      clock.current = Math.max(0, Math.min(duration, next));
      setTimeMs(clock.current);
    },
    [duration],
  );

  const step = (direction: 'previous' | 'next') => {
    const next =
      direction === 'next'
        ? stops.find(stop => stop > clock.current)
        : [...stops].reverse().find(stop => stop < clock.current);
    if (next !== undefined) seek(next);
  };

  const togglePlay = () => {
    if (reduced) return;
    if (clock.current >= duration) {
      clock.current = 0;
      setTimeMs(0);
    }
    setPlaying(value => !value);
  };

  return (
    <View style={styles.shell} testID="comparison3d-preview">
      <Text style={styles.kicker}>OFFLINE PROTOTYPE</Text>
      <Text style={styles.heading} accessibilityRole="header">
        Compare supplied motion
      </Text>
      <Text style={styles.muted}>
        Estimated 3D, not a correction or form assessment.
      </Text>
      <View>
        <View style={styles.panels} testID="comparison3d-headings">
          <View style={styles.panelHeading}>
            <Text style={[styles.caption, styles.motionTitle]}>
              {softwareOnly ? 'Software-only motion' : 'Your motion'}
            </Text>
          </View>
          <View style={styles.panelHeading}>
            <Text style={[styles.caption, styles.referenceTitle]}>
              {model.referenceLabel}
            </Text>
          </View>
        </View>
        <View style={styles.panels} testID="comparison3d-stages">
          <Panel
            id="user"
            title={softwareOnly ? 'Software-only motion' : 'Your motion'}
            tint={color.mint}
            sequence={user}
            frame={sample.user}
            model={model}
            viewIndex={viewIndex}
          />
          <Panel
            id="reference"
            title={model.referenceLabel}
            tint={color.volt}
            sequence={reference}
            frame={sample.reference}
            model={model}
            viewIndex={viewIndex}
          />
        </View>
      </View>
      <Text style={styles.caption} testID="comparison3d-sample-status">
        {sample.status === 'gap'
          ? 'No paired XYZ sample here. Both panels abstain.'
          : 'Supplied sample pair. Unobserved joints are omitted.'}
      </Text>
      <Text
        style={styles.muted}
      >{`XYZ in ${user.units} · shared orthographic scale · no interpolation`}</Text>
      <View>
        <Text
          style={styles.caption}
          testID="comparison3d-clock"
        >{`Comparison time ${Math.round(timeMs)} ms`}</Text>
        <Pressable
          testID="comparison3d-timeline"
          accessibilityRole="adjustable"
          accessibilityLabel="Shared comparison time"
          accessibilityHint="Adjusts both panels together using caller-supplied timestamp pairs. Unmapped intervals remain empty."
          accessibilityValue={{
            min: 0,
            max: duration,
            now: timeMs,
            text: `${Math.round(timeMs)} milliseconds. ${sample.status === 'gap' ? 'No paired evidence.' : 'Supplied sample pair.'}`,
          }}
          accessibilityActions={[
            { name: 'increment', label: 'Next supplied boundary' },
            { name: 'decrement', label: 'Previous supplied boundary' },
          ]}
          onAccessibilityAction={event => {
            if (event.nativeEvent.actionName === 'increment') step('next');
            if (event.nativeEvent.actionName === 'decrement') step('previous');
          }}
          onLayout={event => setTrackWidth(event.nativeEvent.layout.width)}
          onPress={event => {
            if (trackWidth > 0)
              seek((event.nativeEvent.locationX / trackWidth) * duration);
          }}
          style={styles.timeline}
        >
          <View style={styles.track}>
            <View
              style={[
                styles.progress,
                { width: `${(timeMs / duration) * 100}%` },
              ]}
            />
          </View>
        </Pressable>
        <View style={styles.controls}>
          <Control
            label="Previous"
            accessibilityLabel="Previous supplied boundary, both panels"
            testID="comparison3d-previous"
            disabled={timeMs <= 0}
            onPress={() => step('previous')}
          />
          <Control
            label={playing ? 'Pause' : 'Play'}
            accessibilityLabel={
              playing ? 'Pause both panels' : 'Play both panels'
            }
            hint={
              reduced
                ? 'Reduce Motion is on. Use Previous and Next instead.'
                : 'Plays only the caller-supplied timing. No motion is generated between samples.'
            }
            testID="comparison3d-play"
            primary
            disabled={reduced}
            onPress={togglePlay}
          />
          <Control
            label="Next"
            accessibilityLabel="Next supplied boundary, both panels"
            testID="comparison3d-next"
            disabled={timeMs >= duration}
            onPress={() => step('next')}
          />
        </View>
      </View>
      {reduced && (
        <Text style={styles.muted}>
          Reduce Motion is on. Use Previous and Next.
        </Text>
      )}
      <View>
        <Text style={styles.muted}>
          Shared orientation · relative to supplied axes
        </Text>
        <View style={styles.controls}>
          {VIEWS.map((view, index) => (
            <Control
              key={view.label}
              label={view.label}
              accessibilityLabel={`Both panels: yaw ${view.yawDegrees} degrees, pitch ${view.pitchDegrees} degrees`}
              testID={`comparison3d-view-${index}`}
              selected={viewIndex === index}
              onPress={() => setViewIndex(index)}
            />
          ))}
        </View>
      </View>
      <View>
        <Control
          label="Evidence & alignment"
          testID="comparison3d-details"
          expanded={details}
          onPress={() => setDetails(value => !value)}
        />
        {details && (
          <View style={styles.details}>
            {[user, reference].map((source, index) => (
              <Text key={index} style={styles.muted}>
                {`${index === 0 ? 'Motion' : 'Reference'} source: ${source.provenance.sourceId}\n${source.provenance.estimator} · ${source.provenance.recordedAtIso}\nOriginal clock: ${source.provenance.timebaseId} · recording-relative ms`}
              </Text>
            ))}
            <Text
              style={styles.muted}
            >{`Shared frame: ${user.coordinateFrame.id}\nOrigin: ${user.coordinateFrame.origin}\n${user.coordinateFrame.axes} · ${user.coordinateFrame.view} · unmirrored`}</Text>
            <Text
              style={styles.muted}
            >{`Shared center: (${projection.center.x}, ${projection.center.y}, ${projection.center.z}) ${user.units} · radius ${projection.radius} ${user.units}`}</Text>
            <Text
              style={styles.muted}
            >{`Spatial alignment: ${alignment.spatialProvenance}\nTime alignment: ${alignment.provenance}`}</Text>
            <Text style={styles.muted}>
              Exact original frames are held only in caller-supplied [start,
              end) intervals. An interval ending at the timeline's final
              boundary includes that boundary. No nearest-frame matching, time
              warping or body fitting.
            </Text>
            {reference.coachReview && (
              <Text
                style={styles.muted}
              >{`Supplied review: ${reference.coachReview.coachName} · ${reference.coachReview.reviewId}\n${reference.coachReview.reviewedAtIso} · scope: ${reference.coachReview.scope}`}</Text>
            )}
            <Text style={styles.muted}>
              Provenance and any review metadata are caller-supplied, not
              independently verified here. Depth shading is a viewing cue, not
              confidence or form quality.
            </Text>
          </View>
        )}
      </View>
      <Text style={styles.muted}>
        {softwareOnly
          ? 'Software-only fixtures. Not a recording or validated 3D.'
          : 'Caller-supplied estimates. Capture accuracy is not verified here.'}
      </Text>
    </View>
  );
}

export function Experimental3DComparison({
  input,
  offlinePreview = false,
}: Experimental3DComparisonProps) {
  const allowed = __DEV__ && offlinePreview === true;
  const model = useMemo(
    () => (allowed ? prepare3DComparison(input) : null),
    [allowed, input],
  );
  if (!model || model.status === 'unavailable') {
    return (
      <View style={styles.shell} testID="comparison3d-unavailable">
        <Text style={styles.kicker}>OFFLINE PROTOTYPE</Text>
        <Text style={styles.heading} accessibilityRole="header">
          {allowed ? '3D comparison unavailable' : '3D comparison disabled'}
        </Text>
        <Text style={styles.caption}>
          {model?.status === 'unavailable'
            ? model.message
            : 'No app entry point. A development-only preview requires explicit XYZ estimates, a supplied reference and caller alignment.'}
        </Text>
      </View>
    );
  }
  return <OfflinePlayback model={model} />;
}

const styles = StyleSheet.create({
  shell: {
    backgroundColor: color.surfaceDark,
    borderColor: color.lineDark,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.md,
    gap: space.sm,
  },
  kicker: { ...typography.micro, color: color.onDarkMuted },
  heading: { ...typography.h3, color: color.onDark },
  caption: { ...typography.caption, color: color.onDark },
  muted: { ...typography.caption, color: color.onDarkMuted },
  panels: { flexDirection: 'row', gap: space.sm, alignItems: 'stretch' },
  panelHeading: {
    flex: 1,
    minWidth: 0,
    backgroundColor: color.inkElevated,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    paddingHorizontal: space.sm,
    paddingTop: space.sm,
  },
  panel: {
    flex: 1,
    minWidth: 0,
    backgroundColor: color.inkElevated,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    padding: space.sm,
    gap: space.xs,
  },
  motionTitle: { color: color.mint },
  referenceTitle: { color: color.volt },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.sm,
  },
  control: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.inkElevated,
    borderWidth: 1,
    borderColor: color.lineDark,
    borderRadius: radius.sm,
  },
  controlLabel: {
    ...typography.caption,
    color: color.onDark,
    textAlign: 'center',
  },
  primary: { backgroundColor: color.volt, borderColor: color.volt },
  primaryLabel: { color: color.onVolt },
  selected: { backgroundColor: color.courtDeep, borderColor: color.mint },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  timeline: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  track: {
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.lineDark,
    overflow: 'hidden',
  },
  progress: {
    height: 4,
    backgroundColor: color.volt,
    borderRadius: radius.pill,
  },
  details: { gap: space.sm, paddingVertical: space.sm },
});
