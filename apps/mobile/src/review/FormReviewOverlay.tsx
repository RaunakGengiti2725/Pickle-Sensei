import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  Polygon,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import { color } from '../design/tokens';
import {
  REVIEW_JOINTS,
  SKELETON_SEGMENTS,
  type FormReviewScript,
  type JointHeat,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseLandmark,
  type ReviewStop,
} from './formReviewModel';
import {
  arrowVector,
  heatTint,
  stagePoint,
  torsoUnit,
  type Point,
  type Rect,
  type Vector,
} from './formReviewGeometry';

/**
 * FORM REVIEW overlay — the exoskeleton, the translucent fault heat map and
 * the coaching arrow, drawn in stage pixels over the letterboxed video rect.
 *
 * Honesty rules: every bone and joint comes from a landmark the camera
 * actually recorded at this replay time (visibility ≥ 0.35); with no frame
 * nothing is drawn — the Svg stays mounted only so layout never shifts. Heat
 * and arrows come from the review script, i.e. from checkpoints the engine
 * scored. Nothing here invents a body part.
 */

/** Same landmark floor the live camera overlay applies before trusting a joint. */
export const OVERLAY_MIN_VISIBILITY = 0.35;
const HEAT_MIN = 0.03;
const HOT_SEGMENT_MIN = 0.2;
const HOT_JOINT_MIN = 0.45;
/** Arrow shaft length and steadier-ring radius, in torso units. */
export const ARROW_LENGTH_UNITS = 2.6;
export const RING_RADIUS_UNITS = 1.2;
const ARROW_HEAD_PX = 11;
const ARROW_START_UNITS = 0.45;
const LABEL_GAP_PX = 14;
const CONTOUR = 'rgba(0,0,0,0.32)';
const ARROW_CONTOUR = 'rgba(0,0,0,0.55)';

export type JointPoints = Partial<Record<ReviewJoint, Point>>;

function isReviewJoint(name: string): name is ReviewJoint {
  return (REVIEW_JOINTS as readonly string[]).includes(name);
}

/** Visible review joints of one recorded frame, projected into `rect`. */
export function projectJoints(
  rect: Rect,
  frame: ReviewPoseFrame | null,
): JointPoints {
  const out: JointPoints = {};
  // Stored sidecars are strictly parsed, but a frame is still treated as
  // untrusted input: a malformed landmark list draws nothing.
  const landmarks: readonly ReviewPoseLandmark[] | undefined = Array.isArray(
    frame?.landmarks,
  )
    ? frame?.landmarks
    : undefined;
  if (!landmarks) return out;
  for (const mark of landmarks) {
    if (!mark || typeof mark.name !== 'string') continue;
    const name = mark.name;
    if (!isReviewJoint(name) || out[name]) continue;
    if (!(mark.visibility >= OVERLAY_MIN_VISIBILITY)) continue;
    if (!Number.isFinite(mark.x) || !Number.isFinite(mark.y)) continue;
    out[name] = stagePoint(rect, mark);
  }
  return out;
}

/** Body center line (hips, else shoulders, else the joint itself). */
export function bodyCenterX(points: JointPoints, fallback: Point): number {
  const lh = points.left_hip;
  const rh = points.right_hip;
  if (lh && rh) return (lh.x + rh.x) / 2;
  const ls = points.left_shoulder;
  const rs = points.right_shoulder;
  if (ls && rs) return (ls.x + rs.x) / 2;
  return fallback.x;
}

export interface ArrowGeometry {
  /** Stage px of the joint the arrow is anchored on. */
  point: Point;
  /** Unit direction, or null for 'steadier' (drawn as a dashed ring). */
  vector: Vector | null;
  /** Torso unit the arrow is scaled by. */
  unit: number;
  label: string;
}

/**
 * The arrow for a stop at this frame, or null when the stop has no arrow or
 * its joint is not visible in the recorded frame (never guessed).
 */
export function arrowGeometry(
  rect: Rect,
  frame: ReviewPoseFrame | null,
  script: Pick<FormReviewScript, 'facing'>,
  stop: ReviewStop | null,
): ArrowGeometry | null {
  const arrow = stop?.arrow;
  if (!arrow) return null;
  const points = projectJoints(rect, frame);
  const point = points[arrow.joint];
  if (!point) return null;
  const unit = torsoUnit(points);
  const vector = arrowVector(
    arrow.direction,
    script.facing,
    point,
    bodyCenterX(points, point),
  );
  return { point, vector, unit, label: arrow.label };
}

/**
 * Where the RN label chip sits: just past the arrowhead along the arrow
 * (above the ring for 'steadier'), clamped inside the video rect. `joint` is
 * the anchored joint in stage px.
 */
export function arrowLabelAnchor(
  rect: Rect,
  joint: Point,
  vector: Vector | null,
  unit: number,
): Point {
  const direction = vector ?? { dx: 0, dy: -1 };
  const reach = vector
    ? unit * ARROW_LENGTH_UNITS + ARROW_HEAD_PX + LABEL_GAP_PX
    : unit * RING_RADIUS_UNITS + LABEL_GAP_PX;
  const raw = {
    x: joint.x + direction.dx * reach,
    y: joint.y + direction.dy * reach,
  };
  const inset = 8;
  const clamp = (value: number, low: number, high: number) =>
    high <= low ? low : Math.min(high, Math.max(low, value));
  return {
    x: clamp(raw.x, rect.x + inset, rect.x + rect.width - inset),
    y: clamp(raw.y, rect.y + inset, rect.y + rect.height - inset),
  };
}

function heatOf(heat: JointHeat, joint: ReviewJoint): number {
  const value = heat[joint];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 0;
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

interface Bone {
  key: string;
  a: Point;
  b: Point;
  /** Mean heat of the two ends (the neck averages head and shoulders). */
  heat: number;
  /** True when both ends are hot enough to read as one fault region. */
  hot: boolean;
}

/** Segments with both ends visible, plus the neck (head → shoulder midpoint). */
function visibleBones(points: JointPoints, heat: JointHeat): Bone[] {
  const bones: Bone[] = [];
  for (const [from, to] of SKELETON_SEGMENTS) {
    const a = points[from];
    const b = points[to];
    if (!a || !b) continue;
    const fromHeat = heatOf(heat, from);
    const toHeat = heatOf(heat, to);
    bones.push({
      key: `${from}-${to}`,
      a,
      b,
      heat: (fromHeat + toHeat) / 2,
      hot: fromHeat > HOT_SEGMENT_MIN && toHeat > HOT_SEGMENT_MIN,
    });
  }
  const head = points.head;
  const ls = points.left_shoulder;
  const rs = points.right_shoulder;
  if (head && ls && rs) {
    const headHeat = heatOf(heat, 'head');
    const shoulderHeat =
      (heatOf(heat, 'left_shoulder') + heatOf(heat, 'right_shoulder')) / 2;
    bones.push({
      key: 'neck',
      a: head,
      b: midpoint(ls, rs),
      heat: (headHeat + shoulderHeat) / 2,
      hot: headHeat > HOT_SEGMENT_MIN && shoulderHeat > HOT_SEGMENT_MIN,
    });
  }
  return bones;
}

function arrowHead(tip: Point, vector: Vector): string {
  const base = {
    x: tip.x - vector.dx * ARROW_HEAD_PX,
    y: tip.y - vector.dy * ARROW_HEAD_PX,
  };
  const px = -vector.dy * ARROW_HEAD_PX * 0.55;
  const py = vector.dx * ARROW_HEAD_PX * 0.55;
  return `${tip.x},${tip.y} ${base.x + px},${base.y + py} ${base.x - px},${
    base.y - py
  }`;
}

export function FormReviewOverlay(props: {
  rect: Rect;
  frame: ReviewPoseFrame | null;
  heat: JointHeat;
  script: FormReviewScript;
  activeStop: ReviewStop | null;
  showArrow: boolean;
  reducedMotion?: boolean;
}) {
  const points = projectJoints(props.rect, props.frame);
  const unit = torsoUnit(points);
  const bones = visibleBones(points, props.heat);
  const joints = REVIEW_JOINTS.flatMap(joint => {
    const point = points[joint];
    return point ? [{ joint, point, heat: heatOf(props.heat, joint) }] : [];
  });
  const hotJoints = joints.filter(entry => entry.heat > HEAT_MIN);
  const hotBones = bones.filter(bone => bone.hot);
  const arrow = props.showArrow
    ? arrowGeometry(props.rect, props.frame, props.script, props.activeStop)
    : null;

  // The arrow breathes so the eye lands on it; reduced motion holds still.
  const pulse = useRef(new Animated.Value(1)).current;
  const animate = arrow !== null && props.reducedMotion !== true;
  useEffect(() => {
    if (!animate) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.62,
          duration: 640,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 640,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [animate, pulse]);

  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      testID="form-review-overlay"
    >
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id="formReviewHeat" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor={color.flame} stopOpacity={0.95} />
            <Stop offset="0.55" stopColor={color.flame} stopOpacity={0.38} />
            <Stop offset="1" stopColor={color.flame} stopOpacity={0} />
          </RadialGradient>
        </Defs>

        {/* (a) FAULT HEAT — translucent regions on the joints the scored
            checkpoints were measured from; hot limbs read as one region. */}
        {hotBones.map(bone => (
          <Line
            key={`heat-${bone.key}`}
            x1={bone.a.x}
            y1={bone.a.y}
            x2={bone.b.x}
            y2={bone.b.y}
            stroke={color.flame}
            strokeWidth={unit * 1.4}
            strokeLinecap="round"
            opacity={0.12 * bone.heat}
          />
        ))}
        {hotJoints.map(entry => (
          <Circle
            key={`heat-${entry.joint}`}
            cx={entry.point.x}
            cy={entry.point.y}
            r={unit * (1.6 + 1.2 * entry.heat)}
            fill="url(#formReviewHeat)"
            opacity={0.42 * entry.heat}
          />
        ))}

        {/* (b) EXOSKELETON — dark contour under every bone, then the bone
            tinted by its heat. */}
        {bones.map(bone => (
          <Line
            key={`contour-${bone.key}`}
            x1={bone.a.x}
            y1={bone.a.y}
            x2={bone.b.x}
            y2={bone.b.y}
            stroke={CONTOUR}
            strokeWidth={4.8}
            strokeLinecap="round"
          />
        ))}
        {bones.map(bone => (
          <Line
            key={`bone-${bone.key}`}
            x1={bone.a.x}
            y1={bone.a.y}
            x2={bone.b.x}
            y2={bone.b.y}
            stroke={heatTint(bone.heat)}
            strokeWidth={2.6}
            strokeLinecap="round"
            opacity={0.9}
          />
        ))}

        {/* (c) JOINTS — hot joints grow and take a flame ring. */}
        {joints.map(entry => {
          const hot = entry.heat > HOT_JOINT_MIN;
          const radius = hot ? 3.6 * 1.35 : 3.6;
          return (
            <React.Fragment key={`joint-${entry.joint}`}>
              <Circle
                cx={entry.point.x}
                cy={entry.point.y}
                r={radius}
                fill={heatTint(entry.heat)}
                stroke={CONTOUR}
                strokeWidth={1.4}
              />
              {hot ? (
                <Circle
                  cx={entry.point.x}
                  cy={entry.point.y}
                  r={radius + 3.5}
                  fill="none"
                  stroke={color.flame}
                  strokeWidth={1.2}
                  opacity={0.9}
                />
              ) : null}
            </React.Fragment>
          );
        })}
      </Svg>

      {/* (d) ARROW — where the measured joint should go, from the stop's
          scored fault; 'steadier' is a dashed ring around the joint. */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: pulse }]}
        pointerEvents="none"
      >
        <Svg width="100%" height="100%">
          {arrow && arrow.vector ? (
            <ArrowGlyph
              point={arrow.point}
              vector={arrow.vector}
              unit={arrow.unit}
            />
          ) : null}
          {arrow && !arrow.vector ? (
            <>
              <Circle
                cx={arrow.point.x}
                cy={arrow.point.y}
                r={arrow.unit * RING_RADIUS_UNITS}
                fill="none"
                stroke={ARROW_CONTOUR}
                strokeWidth={4.5}
                strokeDasharray="6 5"
              />
              <Circle
                cx={arrow.point.x}
                cy={arrow.point.y}
                r={arrow.unit * RING_RADIUS_UNITS}
                fill="none"
                stroke={color.volt}
                strokeWidth={2.5}
                strokeDasharray="6 5"
                strokeLinecap="round"
              />
            </>
          ) : null}
        </Svg>
      </Animated.View>
    </View>
  );
}

function ArrowGlyph(props: { point: Point; vector: Vector; unit: number }) {
  const { point, vector, unit } = props;
  const start = {
    x: point.x + vector.dx * unit * ARROW_START_UNITS,
    y: point.y + vector.dy * unit * ARROW_START_UNITS,
  };
  const tip = {
    x: point.x + vector.dx * unit * ARROW_LENGTH_UNITS,
    y: point.y + vector.dy * unit * ARROW_LENGTH_UNITS,
  };
  const shaftEnd = {
    x: tip.x - vector.dx * ARROW_HEAD_PX * 0.7,
    y: tip.y - vector.dy * ARROW_HEAD_PX * 0.7,
  };
  const head = arrowHead(tip, vector);
  return (
    <>
      <Line
        x1={start.x}
        y1={start.y}
        x2={shaftEnd.x}
        y2={shaftEnd.y}
        stroke={ARROW_CONTOUR}
        strokeWidth={5}
        strokeLinecap="round"
      />
      <Polygon
        points={head}
        fill={ARROW_CONTOUR}
        stroke={ARROW_CONTOUR}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Line
        x1={start.x}
        y1={start.y}
        x2={shaftEnd.x}
        y2={shaftEnd.y}
        stroke={color.volt}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <Polygon points={head} fill={color.volt} />
    </>
  );
}
