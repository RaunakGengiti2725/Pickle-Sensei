import React, { useMemo } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import type {
  CaptureEvidenceJoint,
  CaptureEvidenceV1,
  CapturedClip,
} from './capture';

type Point = { x: number; y: number };

const BODY_POINTS: Record<CaptureEvidenceJoint, Point> = {
  left_shoulder: { x: 42, y: 42 },
  right_shoulder: { x: 78, y: 42 },
  left_elbow: { x: 29, y: 72 },
  right_elbow: { x: 91, y: 72 },
  left_wrist: { x: 18, y: 104 },
  right_wrist: { x: 102, y: 104 },
  left_hip: { x: 47, y: 96 },
  right_hip: { x: 73, y: 96 },
  left_knee: { x: 43, y: 135 },
  right_knee: { x: 77, y: 135 },
  left_ankle: { x: 39, y: 174 },
  right_ankle: { x: 81, y: 174 },
};

const BODY_SEGMENTS: Array<[CaptureEvidenceJoint, CaptureEvidenceJoint]> = [
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
];

const SPEED_REASON_COPY = {
  calibrated_ball_tracker_unavailable:
    'A calibrated ball tracker is not installed. Body motion is never converted to MPH.',
  camera_not_calibrated:
    'The camera did not have a verified physical-distance calibration.',
  frame_rate_too_low:
    'The measured frame rate was too low for a reliable ball-speed track.',
  track_too_short: 'The ball was not visible for enough measured points.',
  out_of_plane_motion: 'The ball path left the calibrated camera plane.',
  low_confidence: 'The ball track did not clear its confidence threshold.',
  analysis_not_run: 'This imported video has not run a calibrated ball track.',
} as const;

function humanize(value: string) {
  return value.replace(/_/g, ' ');
}

function movementTone(relative: number): string {
  if (relative >= 0.72) return color.flame;
  if (relative >= 0.38) return color.volt;
  if (relative > 0) return color.mint;
  return color.lineStrongDark;
}

function MovementMap({ evidence }: { evidence: CaptureEvidenceV1 }) {
  const motion = useMemo(
    () =>
      new Map(
        evidence.jointMotion.map(item => [
          item.joint,
          item.peakNormalizedPerSecond,
        ]),
      ),
    [evidence.jointMotion],
  );
  const maximum = Math.max(0, ...motion.values());
  const relative = (joint: CaptureEvidenceJoint) =>
    maximum > 0 ? (motion.get(joint) ?? 0) / maximum : 0;

  return (
    <View
      style={styles.mapShell}
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width="100%" height="100%" viewBox="0 0 120 190">
        <Defs>
          <RadialGradient id="headShade" cx="50%" cy="35%" r="65%">
            <Stop
              offset="0%"
              stopColor={color.onDarkMuted}
              stopOpacity="0.42"
            />
            <Stop offset="100%" stopColor={color.lineDark} stopOpacity="0.18" />
          </RadialGradient>
        </Defs>
        <Circle cx="60" cy="20" r="10" fill="url(#headShade)" />
        <Line
          x1="60"
          y1="30"
          x2="60"
          y2="95"
          stroke={color.lineMutedDark}
          strokeWidth="3"
          strokeLinecap="round"
        />
        {BODY_SEGMENTS.map(([from, to]) => {
          const start = BODY_POINTS[from];
          const end = BODY_POINTS[to];
          const intensity = Math.max(relative(from), relative(to));
          return (
            <Line
              key={`${from}-${to}`}
              x1={start.x}
              y1={start.y}
              x2={end.x}
              y2={end.y}
              stroke={movementTone(intensity)}
              strokeOpacity={intensity > 0 ? 0.42 + intensity * 0.5 : 0.34}
              strokeWidth={3 + intensity * 2.4}
              strokeLinecap="round"
            />
          );
        })}
        {(Object.keys(BODY_POINTS) as CaptureEvidenceJoint[]).map(joint => {
          const point = BODY_POINTS[joint];
          const intensity = relative(joint);
          const tone = movementTone(intensity);
          return (
            <React.Fragment key={joint}>
              {intensity > 0 ? (
                <Circle
                  cx={point.x}
                  cy={point.y}
                  r={7 + intensity * 5}
                  fill={tone}
                  opacity={0.1 + intensity * 0.18}
                />
              ) : null}
              <Circle
                cx={point.x}
                cy={point.y}
                r={3.2 + intensity * 1.8}
                fill={tone}
                stroke={color.surfaceDark}
                strokeWidth="1.4"
              />
            </React.Fragment>
          );
        })}
      </Svg>
      <View style={styles.mapLegend}>
        <View style={[styles.legendDot, { backgroundColor: color.mint }]} />
        <Text style={styles.legendCopy}>RELATIVE MOVEMENT</Text>
      </View>
    </View>
  );
}

function EvidenceFact(props: {
  label: string;
  value: string;
  stacked?: boolean;
}) {
  return (
    <View style={[styles.fact, props.stacked && styles.factStacked]}>
      <Text style={[type.h2, styles.factValue]}>{props.value}</Text>
      <Text style={[type.micro, styles.factLabel]}>{props.label}</Text>
    </View>
  );
}

function evidenceAccessibilityLabel(clip: CapturedClip): string {
  if (clip.captureMode === 'imported_video') {
    return 'Imported video. No automatic pose scan was recorded. Ball speed has not been analyzed.';
  }
  const evidence = clip.captureEvidence;
  const mostMovement = [...evidence.jointMotion].sort(
    (a, b) => b.peakNormalizedPerSecond - a.peakNormalizedPerSecond,
  )[0];
  const speed =
    clip.ballSpeed.status === 'measured'
      ? `${clip.ballSpeed.milesPerHour.toFixed(1)} miles per hour measured.`
      : 'Ball speed not measured.';
  return `Real capture evidence. ${
    evidence.poseFrameCount
  } usable pose frames. ${Math.round(
    evidence.meanJointCoverage * 100,
  )} percent average joint coverage. Most camera-relative movement at ${
    mostMovement ? humanize(mostMovement.joint) : 'no retained joint'
  }. ${speed}`;
}

export function CaptureEvidenceCard({ clip }: { clip: CapturedClip }) {
  const { fontScale, width } = useWindowDimensions();
  const compactEvidence = width < 410 || fontScale > 1.15;
  const stackFacts = width < 350 || fontScale > 1.2;
  const evidence =
    clip.captureMode === 'automatic_pose_trigger' ? clip.captureEvidence : null;
  const mostMovement = evidence
    ? [...evidence.jointMotion].sort(
        (a, b) => b.peakNormalizedPerSecond - a.peakNormalizedPerSecond,
      )[0]
    : null;
  const speedTitle =
    clip.ballSpeed.status === 'measured'
      ? `${clip.ballSpeed.milesPerHour.toFixed(1)} MPH`
      : 'Not measured';
  const speedCopy =
    clip.ballSpeed.status === 'measured'
      ? `${Math.round(
          clip.ballSpeed.confidence * 100,
        )}% track confidence · ${clip.ballSpeed.measurementFrameRate.toFixed(
          0,
        )} fps calibrated observation`
      : SPEED_REASON_COPY[clip.ballSpeed.reason];

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={evidenceAccessibilityLabel(clip)}
      style={styles.card}
    >
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <Icon name="shield" color={color.mint} size={19} />
          <Text style={[type.micro, styles.eyebrow]}>
            {evidence ? 'MEASURED MOTION' : 'SOURCE VIDEO'}
          </Text>
        </View>
        <View style={styles.provenancePill}>
          <View style={styles.liveDot} />
          <Text style={styles.provenanceCopy}>
            {evidence ? 'ON-DEVICE' : 'IMPORTED'}
          </Text>
        </View>
      </View>

      {evidence ? (
        <>
          <View
            style={[styles.heroRow, compactEvidence && styles.heroRowCompact]}
          >
            <View
              style={compactEvidence ? styles.mapShellCompactWrap : undefined}
            >
              <MovementMap evidence={evidence} />
            </View>
            <View
              style={[
                styles.heroFacts,
                compactEvidence && styles.heroFactsCompact,
              ]}
            >
              <Text style={[type.micro, styles.movementLabel]}>
                MOST MOVEMENT
              </Text>
              <Text style={[type.h2, styles.movementValue]}>
                {mostMovement ? humanize(mostMovement.joint) : 'Not retained'}
              </Text>
              <Text style={[type.caption, styles.movementCopy]}>
                Relative to this camera frame. This is not a technique score or
                physical speed.
              </Text>
              <View style={styles.visibilityRule} />
              <Text style={[type.micro, styles.visibilityLabel]}>
                POSE VISIBILITY
              </Text>
              <Text style={[type.score, styles.visibilityValue]}>
                {Math.round(evidence.meanCanonicalJointVisibility * 100)}%
              </Text>
            </View>
          </View>

          <View style={[styles.factsRow, stackFacts && styles.factsColumn]}>
            <EvidenceFact
              value={`${evidence.poseFrameCount}`}
              label="POSE FRAMES"
              stacked={stackFacts}
            />
            <View
              style={[
                styles.factDivider,
                stackFacts && styles.factDividerHorizontal,
              ]}
            />
            <EvidenceFact
              value={`${Math.round(evidence.meanJointCoverage * 100)}%`}
              label="JOINT COVERAGE"
              stacked={stackFacts}
            />
            <View
              style={[
                styles.factDivider,
                stackFacts && styles.factDividerHorizontal,
              ]}
            />
            <EvidenceFact
              value={`${(evidence.trackedDurationMs / 1000).toFixed(2)}s`}
              label="TRACKED"
              stacked={stackFacts}
            />
          </View>
        </>
      ) : (
        <View style={[styles.importFacts, stackFacts && styles.factsColumn]}>
          <EvidenceFact
            value={`${(clip.durationMs / 1000).toFixed(1)}s`}
            label="CLIP"
            stacked={stackFacts}
          />
          <EvidenceFact
            value={clip.fps > 0 ? `${Math.round(clip.fps)}` : '—'}
            label="SOURCE FPS"
            stacked={stackFacts}
          />
          <EvidenceFact
            value={`${clip.height}p`}
            label="FRAME"
            stacked={stackFacts}
          />
        </View>
      )}

      <View style={styles.speedPanel}>
        <View style={styles.speedIcon}>
          <Icon
            name={clip.ballSpeed.status === 'measured' ? 'spark' : 'lock'}
            color={
              clip.ballSpeed.status === 'measured' ? color.volt : color.mint
            }
            size={19}
          />
        </View>
        <View style={styles.speedBody}>
          <Text style={[type.micro, styles.speedLabel]}>BALL SPEED</Text>
          <Text style={[type.h3, styles.speedTitle]}>{speedTitle}</Text>
          <Text style={[type.caption, styles.speedCopy]}>{speedCopy}</Text>
        </View>
      </View>

      <Text style={[type.caption, styles.trace]}>
        {evidence
          ? `${clip.preRollMs}ms before · ${
              clip.postRollMs
            }ms after · ${evidence.poseSource.replace(/_/g, ' ')} · ${
              evidence.poseModelVersion
            } · ${evidence.triggerAlgorithmVersion}`
          : 'Copied to private app storage · no scan reconstructed'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.xl,
    padding: space.lg,
    borderRadius: radius.xl,
    backgroundColor: color.surfaceDark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  headerTitle: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  eyebrow: { color: color.onDarkMuted },
  provenancePill: {
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.inkElevated,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.mint,
  },
  provenanceCopy: { ...type.micro, color: color.onDarkMuted },
  heroRow: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  heroRowCompact: { flexDirection: 'column' },
  mapShellCompactWrap: { alignSelf: 'center' },
  mapShell: {
    width: 132,
    height: 208,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.cameraSurface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineMutedDark,
    paddingTop: 6,
    paddingBottom: 22,
  },
  mapLegend: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  legendDot: { width: 5, height: 5, borderRadius: 3 },
  legendCopy: { ...type.micro, color: color.onDarkFaint },
  heroFacts: { flex: 1, paddingVertical: space.sm },
  heroFactsCompact: { paddingTop: 0 },
  movementLabel: { color: color.mint },
  movementValue: {
    color: color.onDark,
    textTransform: 'capitalize',
    marginTop: space.xs,
  },
  movementCopy: { color: color.onDarkSubtle, marginTop: space.sm },
  visibilityRule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.lineDark,
    marginVertical: space.md,
  },
  visibilityLabel: { color: color.onDarkMuted },
  visibilityValue: { color: color.volt, fontSize: 38, lineHeight: 42 },
  factsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: space.lg,
  },
  factsColumn: { flexDirection: 'column', gap: space.sm },
  importFacts: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.xl,
  },
  fact: { flex: 1 },
  factStacked: { flex: 0, width: '100%' },
  factValue: { color: color.onDark, fontVariant: ['tabular-nums'] },
  factLabel: { color: color.onDarkFaint, marginTop: 2 },
  factDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: color.lineDark,
    marginHorizontal: 10,
  },
  factDividerHorizontal: {
    width: '100%',
    height: StyleSheet.hairlineWidth,
    marginHorizontal: 0,
  },
  speedPanel: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.inkElevated,
  },
  speedIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTint,
  },
  speedBody: { flex: 1 },
  speedLabel: { color: color.onDarkMuted },
  speedTitle: { color: color.onDark, marginTop: 2 },
  speedCopy: { color: color.onDarkSubtle, marginTop: 3 },
  trace: {
    color: color.onDarkFaint,
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
});
