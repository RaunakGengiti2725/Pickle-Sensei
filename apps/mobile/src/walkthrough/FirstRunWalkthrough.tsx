import React, { useCallback, useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Button } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import {
  hasWalkthroughTarget,
  measureWalkthroughTarget,
  type TargetRect,
  type WalkthroughTargetKey,
} from './targets';
import { useWalkthroughStore } from './walkthroughStore';

/**
 * The first-run walkthrough — a spotlight tour over the REAL interface.
 * Each step dims the screen, cuts a bright hole around the actual element
 * (the Coach button, the rank banner, the tabs), draws an arrow into it, and
 * explains that element where it lives. Positions come from live
 * measurement (targets.ts), never from hardcoded layouts, and a step whose
 * target cannot be measured right now is skipped instead of pointing at
 * empty space.
 *
 * Copy rules it never breaks: every claim is a behavior the shipping build
 * actually has — automatic capture, the import path, permits released on
 * every unscored outcome, on-device analysis. No promised accuracy, no
 * invented numbers.
 *
 * Interaction rules, from the ceremony surfaces: it never blocks input
 * (backdrop tap and Skip both end it immediately), and the store's durable
 * device record guarantees it is raised once — Settings → About replays it.
 */

interface WalkthroughStep {
  key: string;
  targetKey: WalkthroughTargetKey;
  /** Spotlight shape: 'circle' hugs round controls, 'rounded' hugs cards. */
  shape: 'circle' | 'rounded';
  eyebrow: string;
  headline: string;
  body: string;
  finePrint?: string;
}

export const WALKTHROUGH_STEPS: readonly WalkthroughStep[] = [
  {
    key: 'coach',
    targetKey: 'coach-fab',
    shape: 'circle',
    eyebrow: 'START HERE',
    headline: 'Every read starts here.',
    body: 'Auto Analyze: prop the phone and play — your stroke is captured automatically. Import Video: rate a clip you already have.',
  },
  {
    key: 'honest',
    targetKey: 'rank-banner',
    shape: 'rounded',
    eyebrow: 'HONEST RATINGS',
    headline: 'Only clear reads count.',
    body: 'Clear reads build your rank and streak. If a stroke can’t be read, the app says so — and it costs nothing.',
    finePrint: 'Two validated ratings free · Unscored attempts don’t count',
  },
  {
    key: 'library',
    targetKey: 'tab-library',
    shape: 'rounded',
    eyebrow: 'YOUR READS',
    headline: 'Your reads live here.',
    body: 'Scored reads and saved clips, all in one place.',
  },
  {
    key: 'progress',
    targetKey: 'tab-progress',
    shape: 'rounded',
    eyebrow: 'OVER TIME',
    headline: 'Track progress here.',
    body: 'Streaks, trends, and personal bests from your real reads.',
  },
] as const;

/** Padding between a target's true bounds and its spotlight hole. */
const HOLE_PADDING = 8;
/** Vertical room between the hole and the callout card — the arrow's lane. */
const ARROW_LANE = 92;
const SCREEN_MARGIN = space.lg;

interface Hole {
  x: number;
  y: number;
  width: number;
  height: number;
  r: number;
  centerX: number;
  bottom: number;
}

function holeForTarget(rect: TargetRect, shape: 'circle' | 'rounded'): Hole {
  if (shape === 'circle') {
    const side = Math.max(rect.width, rect.height) + HOLE_PADDING * 2 - 2;
    const x = rect.x + rect.width / 2 - side / 2;
    const y = rect.y + rect.height / 2 - side / 2;
    return {
      x,
      y,
      width: side,
      height: side,
      r: side / 2,
      centerX: x + side / 2,
      bottom: y + side,
    };
  }
  const x = rect.x - HOLE_PADDING;
  const y = rect.y - HOLE_PADDING;
  const width = rect.width + HOLE_PADDING * 2;
  const height = rect.height + HOLE_PADDING * 2;
  return {
    x,
    y,
    width,
    height,
    r: Math.min(20, Math.min(width, height) / 2),
    centerX: x + width / 2,
    bottom: y + height,
  };
}

function roundedRectPath(h: Hole): string {
  const { x, y, width: w, height: ht, r } = h;
  return [
    `M ${x + r} ${y}`,
    `h ${w - 2 * r}`,
    `a ${r} ${r} 0 0 1 ${r} ${r}`,
    `v ${ht - 2 * r}`,
    `a ${r} ${r} 0 0 1 ${-r} ${r}`,
    `h ${-(w - 2 * r)}`,
    `a ${r} ${r} 0 0 1 ${-r} ${-r}`,
    `v ${-(ht - 2 * r)}`,
    `a ${r} ${r} 0 0 1 ${r} ${-r}`,
    'z',
  ].join(' ');
}

/** Scrim covering the screen with the spotlight cut out (even-odd fill). */
function scrimPath(w: number, h: number, hole: Hole): string {
  return `M 0 0 H ${w} V ${h} H 0 Z ${roundedRectPath(hole)}`;
}

interface Point {
  x: number;
  y: number;
}

/** A gently curved arrow from the callout to the spotlight, with its head at
 * the target end. Pure geometry — testable and deterministic. */
export function arrowGeometry(from: Point, to: Point) {
  const bend = Math.max(-44, Math.min(44, (to.x - from.x) * 0.55)) || 26;
  const control: Point = {
    x: (from.x + to.x) / 2 + bend,
    y: (from.y + to.y) / 2,
  };
  const shaft = `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`;
  // Tangent at the end of a quadratic curve points from control to end.
  const angle = Math.atan2(to.y - control.y, to.x - control.x);
  const wing = 11;
  const spread = 0.5;
  const head =
    `M ${to.x - wing * Math.cos(angle - spread)} ${to.y - wing * Math.sin(angle - spread)} ` +
    `L ${to.x} ${to.y} ` +
    `L ${to.x - wing * Math.cos(angle + spread)} ${to.y - wing * Math.sin(angle + spread)}`;
  return { shaft, head };
}

function StepSpotlight(props: {
  step: WalkthroughStep;
  stepIndex: number;
  rect: TargetRect;
  onAdvance: () => void;
  onSkip: () => void;
  isLast: boolean;
}) {
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { step, rect } = props;
  const hole = holeForTarget(rect, step.shape);

  // Callout below a target in the top half of the screen, above one in the
  // bottom half — the arrow always has room to travel.
  const calloutBelow = hole.y + hole.height / 2 < windowHeight * 0.52;
  const calloutTop = calloutBelow ? hole.bottom + ARROW_LANE : undefined;
  const calloutBottomEdge = hole.y - ARROW_LANE;
  const calloutBottom = calloutBelow
    ? undefined
    : windowHeight - calloutBottomEdge;

  const arrowStartX = Math.max(
    SCREEN_MARGIN + 84,
    Math.min(hole.centerX, windowWidth - SCREEN_MARGIN - 84),
  );
  const arrow = calloutBelow
    ? arrowGeometry(
        { x: arrowStartX, y: (calloutTop ?? 0) - 12 },
        { x: hole.centerX, y: hole.bottom + 9 },
      )
    : arrowGeometry(
        { x: arrowStartX, y: calloutBottomEdge + 12 },
        { x: hole.centerX, y: hole.y - 9 },
      );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Svg
        width={windowWidth}
        height={windowHeight}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      >
        <Path
          d={scrimPath(windowWidth, windowHeight, hole)}
          fill={color.overlayDark}
          fillRule="evenodd"
        />
        <Path
          d={roundedRectPath({
            ...hole,
            x: hole.x - 3,
            y: hole.y - 3,
            width: hole.width + 6,
            height: hole.height + 6,
            r: hole.r + 3,
          })}
          stroke={color.volt}
          strokeWidth={2}
          fill="none"
        />
        <Path
          d={arrow.shaft}
          stroke={color.volt}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeDasharray="1 7"
          fill="none"
        />
        <Path
          d={arrow.head}
          stroke={color.volt}
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>

      <View
        accessibilityViewIsModal
        style={[
          styles.callout,
          calloutTop !== undefined && { top: calloutTop },
          calloutBottom !== undefined && { bottom: calloutBottom },
        ]}
      >
        <Text style={[type.micro, styles.eyebrow]}>{step.eyebrow}</Text>
        <Text style={[type.h2, styles.headline]}>{step.headline}</Text>
        <Text style={[type.body, styles.body]}>{step.body}</Text>
        {step.finePrint ? (
          <Text style={[type.caption, styles.finePrint]}>{step.finePrint}</Text>
        ) : null}
        <View style={styles.controls}>
          <View style={styles.dots}>
            {WALKTHROUGH_STEPS.map((candidate, dotIndex) => (
              <View
                key={candidate.key}
                style={[
                  styles.dot,
                  dotIndex === props.stepIndex && styles.dotActive,
                ]}
              />
            ))}
          </View>
          <View style={styles.controlButtons}>
            {props.isLast ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Skip walkthrough"
                testID="walkthrough-skip"
                onPress={props.onSkip}
                hitSlop={12}
                style={styles.skip}
              >
                <Text style={[type.bodyBold, styles.skipText]}>Skip</Text>
              </Pressable>
            )}
            <Button
              label={props.isLast ? 'Got it' : 'Next'}
              variant="volt"
              compact
              testID="walkthrough-advance"
              onPress={props.onAdvance}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

/** A target only counts when it is actually in the viewport — a scrolled-away
 * banner still measures, but pointing at coordinates above the screen leaves
 * the user staring at a bare scrim. Center on screen ⇒ at least half of the
 * target is visible, which is enough to spotlight honestly. */
export function rectVisibleInWindow(
  rect: TargetRect,
  windowWidth: number,
  windowHeight: number,
): boolean {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return (
    centerX >= 0 &&
    centerX <= windowWidth &&
    centerY >= 0 &&
    centerY <= windowHeight
  );
}

function WalkthroughStage() {
  const dismiss = useWalkthroughStore(s => s.dismiss);
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<TargetRect | null>(null);
  const step = WALKTHROUGH_STEPS[index]!;
  const isLast = index === WALKTHROUGH_STEPS.length - 1;

  const advance = useCallback(() => {
    if (index >= WALKTHROUGH_STEPS.length - 1) {
      dismiss();
      return;
    }
    setIndex(index + 1);
  }, [dismiss, index]);

  // Measure the current step's target. A registered target gets a few
  // attempts (layout may still be settling after a tab switch); an
  // unregistered one is skipped immediately. A step that never measures is
  // skipped — the tour must not point at empty space.
  useEffect(() => {
    let cancelled = false;
    setRect(null);
    (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (cancelled) return;
        if (!hasWalkthroughTarget(step.targetKey)) break;
        const measured = await measureWalkthroughTarget(step.targetKey);
        if (cancelled) return;
        if (measured && rectVisibleInWindow(measured, windowWidth, windowHeight)) {
          setRect(measured);
          return;
        }
        await new Promise<void>(resolve => setTimeout(() => resolve(), 120));
      }
      if (cancelled) return;
      if (index >= WALKTHROUGH_STEPS.length - 1) {
        dismiss();
        return;
      }
      setIndex(index + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [dismiss, index, step.targetKey, windowWidth, windowHeight]);

  useEffect(() => {
    if (!rect) return;
    AccessibilityInfo.announceForAccessibility(
      `Walkthrough, step ${index + 1} of ${WALKTHROUGH_STEPS.length}. ${
        step.headline
      } ${step.body}`,
    );
  }, [index, rect, step]);

  return (
    <View style={styles.root} testID="first-run-walkthrough">
      <Pressable
        accessibilityLabel="Dismiss walkthrough"
        onPress={dismiss}
        style={StyleSheet.absoluteFill}
      />
      {rect ? (
        <StepSpotlight
          key={step.key}
          step={step}
          stepIndex={index}
          rect={rect}
          onAdvance={advance}
          onSkip={dismiss}
          isLast={isLast}
        />
      ) : null}
    </View>
  );
}

export function FirstRunWalkthrough() {
  const visible = useWalkthroughStore(s => s.visible);
  const dismiss = useWalkthroughStore(s => s.dismiss);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      animationType="fade"
      onRequestClose={dismiss}
    >
      {visible ? <WalkthroughStage /> : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  callout: {
    position: 'absolute',
    left: SCREEN_MARGIN,
    right: SCREEN_MARGIN,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.lineDark,
    backgroundColor: color.inkElevated,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  eyebrow: { color: color.volt },
  headline: { color: color.onDark, marginTop: space.sm },
  body: { color: color.onDarkMuted, marginTop: space.sm },
  finePrint: { color: color.onDarkSubtle, marginTop: space.sm },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: space.md,
  },
  dots: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.onDarkTint,
  },
  dotActive: { width: 18, backgroundColor: color.volt },
  controlButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  skip: { paddingVertical: space.sm },
  skipText: { color: color.onDarkMuted },
});
