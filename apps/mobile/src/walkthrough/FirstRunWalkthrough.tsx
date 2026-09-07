import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type HostInstance,
  type LayoutChangeEvent,
} from 'react-native';
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
} from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';
import { Button, LoadingState } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import {
  hasWalkthroughTarget,
  measureWalkthroughTarget,
  type TargetRect,
  type WalkthroughTargetKey,
} from './targets';
import { CeremonyHost, useCeremonyPresentation } from '../flow/CeremonyHost';

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
const CALLOUT_CHROME_HEIGHT = space.lg + space.md * 2 + 2;
const MIN_TOUCH_TARGET = 44;
const NO_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

export function walkthroughViewport(
  frame: TargetRect,
  window: { width: number; height: number },
  insets: EdgeInsets,
): TargetRect {
  const left = clamp(insets.left - frame.x, 0, frame.width);
  const top = clamp(insets.top - frame.y, 0, frame.height);
  const right = clamp(window.width - insets.right - frame.x, left, frame.width);
  const bottom = clamp(
    window.height - insets.bottom - frame.y,
    top,
    frame.height,
  );
  const horizontalMargin = Math.min(SCREEN_MARGIN, (right - left) / 2);
  const verticalMargin = Math.min(SCREEN_MARGIN, (bottom - top) / 2);
  return {
    x: left + horizontalMargin,
    y: top + verticalMargin,
    width: right - left - horizontalMargin * 2,
    height: bottom - top - verticalMargin * 2,
  };
}

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

export function walkthroughCalloutLayout(
  viewport: TargetRect,
  target: TargetRect,
  shape: WalkthroughStep['shape'],
  measurements: {
    bodyHeight: number | null;
    controlsHeight: number | null;
    minimumBodyHeight?: number;
  },
) {
  const hole = holeForTarget(target, shape);
  const bottom = viewport.y + viewport.height;
  const controlsHeight = Math.max(
    MIN_TOUCH_TARGET,
    measurements.controlsHeight ?? MIN_TOUCH_TARGET,
  );
  const reservedHeight = controlsHeight + CALLOUT_CHROME_HEIGHT;

  // Callout below a target in the top half of the screen, above one in the
  // bottom half — the arrow always has room to travel.
  let below = hole.y + hole.height / 2 < viewport.y + viewport.height * 0.52;
  const measurementsReady =
    measurements.bodyHeight !== null && measurements.controlsHeight !== null;
  const naturalHeight = measurementsReady
    ? measurements.bodyHeight! + reservedHeight
    : Infinity;
  const room = (onBottom: boolean, gap: number) =>
    clamp(
      onBottom ? bottom - hole.bottom - gap : hole.y - gap - viewport.y,
      0,
      viewport.height,
    );
  let gap = ARROW_LANE;
  if (naturalHeight > room(below, gap)) {
    if (naturalHeight <= room(!below, gap)) {
      below = !below;
    } else {
      gap = space.md;
      if (
        naturalHeight > room(below, gap) &&
        room(!below, gap) > room(below, gap)
      ) {
        below = !below;
      }
    }
  }
  const minimumHeight =
    reservedHeight +
    Math.min(
      measurements.bodyHeight ?? Infinity,
      Math.max(MIN_TOUCH_TARGET, measurements.minimumBodyHeight ?? 0),
    );
  let maxHeight = room(below, gap);
  if (maxHeight < minimumHeight) {
    const center = clamp(hole.y + hole.height / 2, viewport.y, bottom);
    const aboveCenter = Math.max(0, center - viewport.y - space.md);
    const belowCenter = Math.max(0, bottom - center - space.md);
    below = belowCenter >= aboveCenter;
    maxHeight = below ? belowCenter : aboveCenter;
  }
  const height = Math.min(naturalHeight, maxHeight);
  const top = clamp(
    below ? hole.bottom + gap : hole.y - gap - height,
    viewport.y,
    bottom - height,
  );
  maxHeight = Math.min(maxHeight, bottom - top);
  return {
    left: viewport.x,
    top,
    width: viewport.width,
    height,
    maxHeight,
    bodyMaxHeight: Math.max(0, maxHeight - reservedHeight),
    scrollControls: !measurementsReady || maxHeight < minimumHeight,
    below,
  };
}

function StepSpotlight(props: {
  step: WalkthroughStep;
  stepIndex: number;
  rect: TargetRect;
  frame: TargetRect;
  viewport: TargetRect;
  minimumBodyHeight: number;
  onAdvance: () => void;
  onSkip: () => void;
  isLast: boolean;
}) {
  const { step, rect, frame, viewport } = props;
  const [bodyHeight, setBodyHeight] = useState<number | null>(null);
  const [controlsHeight, setControlsHeight] = useState<number | null>(null);
  const hole = holeForTarget(rect, step.shape);
  const layout = walkthroughCalloutLayout(viewport, rect, step.shape, {
    bodyHeight,
    controlsHeight,
    minimumBodyHeight: props.minimumBodyHeight,
  });
  const arrowInset = Math.min(84, layout.width / 2);
  const arrowStartX = clamp(
    hole.centerX,
    layout.left + arrowInset,
    layout.left + layout.width - arrowInset,
  );
  const calloutBottomEdge = layout.top + layout.height;
  const showArrow =
    bodyHeight !== null &&
    controlsHeight !== null &&
    (layout.below ? layout.top - hole.bottom : hole.y - calloutBottomEdge) >=
      space.xl;
  const arrow = layout.below
    ? arrowGeometry(
        { x: arrowStartX, y: layout.top - 12 },
        { x: hole.centerX, y: hole.bottom + 9 },
      )
    : arrowGeometry(
        { x: arrowStartX, y: calloutBottomEdge + 12 },
        { x: hole.centerX, y: hole.y - 9 },
      );
  const contentWidth = Math.max(0, layout.width - space.lg * 2 - 2);
  const matchesWidth = (width: number) =>
    Number.isFinite(width) && Math.abs(width - contentWidth) <= 1;
  const measureBody = (width: number, height: number) => {
    if (matchesWidth(width) && Number.isFinite(height) && height >= 0) {
      setBodyHeight(height);
    }
  };
  const copy = (
    <View
      testID="walkthrough-copy-content"
      onLayout={({ nativeEvent: { layout: measured } }) => {
        measureBody(measured.width, measured.height);
      }}
    >
      <Text allowFontScaling style={[type.micro, styles.eyebrow]}>
        {step.eyebrow}
      </Text>
      <Text allowFontScaling style={[type.h2, styles.headline]}>
        {step.headline}
      </Text>
      <Text allowFontScaling style={[type.body, styles.body]}>
        {step.body}
      </Text>
      {step.finePrint ? (
        <Text allowFontScaling style={[type.caption, styles.finePrint]}>
          {step.finePrint}
        </Text>
      ) : null}
    </View>
  );
  const controls = (
    <View
      style={styles.controls}
      testID="walkthrough-controls"
      onLayout={({ nativeEvent: { layout: measured } }) => {
        if (
          matchesWidth(measured.width) &&
          Number.isFinite(measured.height) &&
          measured.height > 0
        ) {
          setControlsHeight(measured.height);
        }
      }}
    >
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
      <View style={styles.controlButtons} testID="walkthrough-control-buttons">
        {props.isLast ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Skip walkthrough"
            testID="walkthrough-skip"
            onPress={props.onSkip}
            hitSlop={12}
            style={styles.skip}
          >
            <Text allowFontScaling style={[type.bodyBold, styles.skipText]}>
              Skip
            </Text>
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
  );

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Svg
        width={frame.width}
        height={frame.height}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      >
        <Path
          d={scrimPath(frame.width, frame.height, hole)}
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
        {showArrow ? (
          <>
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
          </>
        ) : null}
      </Svg>

      <View
        accessibilityViewIsModal
        onAccessibilityEscape={props.onSkip}
        testID="walkthrough-callout"
        style={[
          styles.callout,
          !layout.scrollControls && styles.calloutContent,
          {
            left: layout.left,
            top: layout.top,
            width: layout.width,
            height: layout.height,
            maxHeight: layout.maxHeight,
          },
        ]}
      >
        {layout.scrollControls ? (
          <ScrollView
            testID="walkthrough-overflow"
            style={[styles.copy, { maxHeight: Math.max(0, layout.height - 2) }]}
            contentContainerStyle={styles.calloutContent}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            showsVerticalScrollIndicator
            indicatorStyle="white"
            bounces={false}
          >
            {copy}
            {controls}
          </ScrollView>
        ) : (
          <>
            <ScrollView
              testID="walkthrough-copy"
              style={[styles.copy, { maxHeight: layout.bodyMaxHeight }]}
              contentInsetAdjustmentBehavior="never"
              automaticallyAdjustContentInsets={false}
              showsVerticalScrollIndicator
              indicatorStyle="white"
              bounces={false}
              onContentSizeChange={measureBody}
            >
              {copy}
            </ScrollView>
            {controls}
          </>
        )}
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

function WalkthroughStage({ dismiss }: { dismiss: () => void }) {
  const {
    width: windowWidth,
    height: windowHeight,
    fontScale,
    scale,
  } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext) ?? NO_INSETS;
  const environment = useMemo(
    () => ({
      windowWidth,
      windowHeight,
      fontScale,
      scale,
      top: insets.top,
      bottom: insets.bottom,
      left: insets.left,
      right: insets.right,
    }),
    [
      windowWidth,
      windowHeight,
      fontScale,
      scale,
      insets.top,
      insets.bottom,
      insets.left,
      insets.right,
    ],
  );
  const currentEnvironment = useRef<typeof environment | null>(environment);
  const hostRef = useRef<HostInstance | null>(null);
  const hostMeasurement = useRef(0);
  const [hostLayout, setHostLayout] = useState<{
    frame: TargetRect;
    windowWidth: number;
    windowHeight: number;
  } | null>(null);
  const frame =
    hostLayout?.windowWidth === windowWidth &&
    hostLayout.windowHeight === windowHeight
      ? hostLayout.frame
      : { x: 0, y: 0, width: windowWidth, height: windowHeight };
  const viewport = walkthroughViewport(
    frame,
    { width: windowWidth, height: windowHeight },
    insets,
  );
  const currentFrame = useRef(frame);
  useLayoutEffect(() => {
    currentFrame.current = frame;
  }, [frame]);
  const [index, setIndex] = useState(0);
  const layoutKey = [
    index,
    windowWidth,
    windowHeight,
    fontScale,
    scale,
    insets.top,
    insets.bottom,
    insets.left,
    insets.right,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
  ].join(':');
  const [measurement, setMeasurement] = useState<{
    key: string;
    rect: TargetRect;
  } | null>(null);
  const rect = measurement?.key === layoutKey ? measurement.rect : null;
  const step = WALKTHROUGH_STEPS[index]!;
  const isLast = index === WALKTHROUGH_STEPS.length - 1;

  const updateHostFrame = useCallback(
    (measured: TargetRect) => {
      if (
        currentEnvironment.current !== environment ||
        !Object.values(measured).every(Number.isFinite) ||
        measured.width <= 0 ||
        measured.height <= 0
      )
        return;
      setHostLayout(current => {
        if (
          current?.windowWidth === windowWidth &&
          current.windowHeight === windowHeight &&
          current.frame.x === measured.x &&
          current.frame.y === measured.y &&
          current.frame.width === measured.width &&
          current.frame.height === measured.height
        )
          return current;
        return { frame: measured, windowWidth, windowHeight };
      });
    },
    [windowWidth, windowHeight, environment],
  );

  const measureHost = useCallback(() => {
    const measurement = ++hostMeasurement.current;
    hostRef.current?.measureInWindow((x, y, width, height) => {
      if (measurement !== hostMeasurement.current) return;
      updateHostFrame({ x, y, width, height });
    });
  }, [updateHostFrame]);

  useLayoutEffect(() => {
    currentEnvironment.current = environment;
    measureHost();
    return () => {
      currentEnvironment.current = null;
      hostMeasurement.current += 1;
    };
  }, [measureHost, environment]);

  const onHostLayout = useCallback(
    ({ nativeEvent: { layout } }: LayoutChangeEvent) => {
      if (currentEnvironment.current !== environment) return;
      updateHostFrame({
        ...currentFrame.current,
        width: layout.width,
        height: layout.height,
      });
      measureHost();
    },
    [environment, measureHost, updateHostFrame],
  );

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
    setMeasurement(null);
    (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (cancelled) return;
        if (!hasWalkthroughTarget(step.targetKey)) break;
        const measured = await measureWalkthroughTarget(step.targetKey);
        if (cancelled) return;
        const local = measured
          ? {
              ...measured,
              x: measured.x - frame.x,
              y: measured.y - frame.y,
            }
          : null;
        if (
          measured &&
          local &&
          rectVisibleInWindow(measured, windowWidth, windowHeight) &&
          rectVisibleInWindow(local, frame.width, frame.height)
        ) {
          setMeasurement({ key: layoutKey, rect: local });
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
  }, [
    dismiss,
    index,
    step.targetKey,
    layoutKey,
    windowWidth,
    windowHeight,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
  ]);

  useEffect(() => {
    if (!rect) return;
    AccessibilityInfo.announceForAccessibility(
      `Walkthrough, step ${index + 1} of ${WALKTHROUGH_STEPS.length}. ${
        step.headline
      } ${step.body}`,
    );
  }, [index, rect, step]);

  return (
    <View
      ref={hostRef}
      collapsable={false}
      style={[styles.root, !rect && styles.measuringBackdrop]}
      testID="first-run-walkthrough"
      onLayout={onHostLayout}
      onAccessibilityEscape={dismiss}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss walkthrough"
        onPress={dismiss}
        style={StyleSheet.absoluteFill}
      />
      {rect ? (
        <StepSpotlight
          key={layoutKey}
          step={step}
          stepIndex={index}
          rect={rect}
          frame={frame}
          viewport={viewport}
          minimumBodyHeight={type.h2.lineHeight * fontScale}
          onAdvance={advance}
          onSkip={dismiss}
          isLast={isLast}
        />
      ) : (
        <View
          style={[
            styles.measuring,
            {
              left: viewport.x,
              top: viewport.y,
              width: viewport.width,
              bottom: frame.height - viewport.y - viewport.height,
            },
          ]}
          pointerEvents="box-none"
          testID="walkthrough-measuring"
        >
          <ScrollView
            testID="walkthrough-measuring-copy"
            style={styles.measuringCopy}
            contentContainerStyle={styles.measuringContent}
            contentInsetAdjustmentBehavior="never"
            automaticallyAdjustContentInsets={false}
            showsVerticalScrollIndicator
            indicatorStyle="white"
            bounces={false}
          >
            <LoadingState dark label="Finding this part of the app" />
          </ScrollView>
          <View
            style={styles.measuringControls}
            testID="walkthrough-measuring-controls"
          >
            <Button
              label="Skip"
              variant="volt"
              testID="walkthrough-skip"
              onPress={dismiss}
            />
          </View>
        </View>
      )}
    </View>
  );
}

export function FirstRunWalkthrough() {
  const presentation = useCeremonyPresentation();
  if (!presentation) {
    return (
      <CeremonyHost kinds={['walkthrough']}>
        <FirstRunWalkthrough />
      </CeremonyHost>
    );
  }
  if (presentation.ceremony.kind !== 'walkthrough') return null;
  return <WalkthroughStage dismiss={presentation.dismiss} />;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  measuringBackdrop: { backgroundColor: color.overlayDark },
  measuring: { position: 'absolute' },
  measuringCopy: { flex: 1, minHeight: 0 },
  measuringContent: { flexGrow: 1 },
  measuringControls: { flexShrink: 0, marginTop: space.md },
  callout: {
    position: 'absolute',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.lineDark,
    backgroundColor: color.inkElevated,
  },
  calloutContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  copy: { flexGrow: 0, flexShrink: 1, minHeight: 0 },
  eyebrow: { color: color.volt },
  headline: { color: color.onDark, marginTop: space.sm },
  body: { color: color.onDarkMuted, marginTop: space.sm },
  finePrint: { color: color.onDarkSubtle, marginTop: space.sm },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
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
    flexWrap: 'wrap',
    flexGrow: 1,
    maxWidth: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.md,
  },
  skip: {
    paddingVertical: space.sm,
    minWidth: MIN_TOUCH_TARGET,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipText: { color: color.onDarkMuted },
});
