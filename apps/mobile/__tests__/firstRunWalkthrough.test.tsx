import '../testSupport/ceremonyNativeLifecycle';
import React from 'react';
import {
  AccessibilityInfo,
  Dimensions,
  Modal,
  ScrollView,
  StyleSheet,
  View,
  Text,
  type HostInstance,
} from 'react-native';
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
} from 'react-native-safe-area-context';
import TestRenderer, { act } from 'react-test-renderer';

// The walkthrough store persists through SQLite; the native module is absent
// under jest and these tests drive store state directly.
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

let mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
}));
let mockReducedMotion = false;
jest.mock('../src/design/components', () => {
  const actual = jest.requireActual<typeof import('../src/design/components')>(
    '../src/design/components',
  );
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
  arrowGeometry,
  walkthroughCalloutLayout,
  walkthroughViewport,
} from '../src/walkthrough/FirstRunWalkthrough';
import { Button, PressableScale } from '../src/design/components';
import { space } from '../src/design/tokens';
import {
  registerWalkthroughMeasurer,
  type WalkthroughTargetKey,
} from '../src/walkthrough/targets';
import { useWalkthroughStore } from '../src/walkthrough/walkthroughStore';

/**
 * Spotlight-tour surface tests: each step anchors to a REAL measured target
 * (fake measurers here), steps whose target is absent are skipped instead of
 * pointing at empty space, Next walks the sequence, and Skip / backdrop /
 * the final CTA all dismiss. Arrow geometry is asserted as pure math.
 */

const TARGET_RECTS: Record<
  WalkthroughTargetKey,
  { x: number; y: number; width: number; height: number }
> = {
  'coach-fab': { x: 165, y: 700, width: 64, height: 64 },
  'rank-banner': { x: 24, y: 120, width: 345, height: 96 },
  'home-streak': { x: 313, y: 62, width: 56, height: 32 },
  'tab-library': { x: 96, y: 760, width: 70, height: 54 },
  'tab-progress': { x: 236, y: 760, width: 70, height: 54 },
};

let unregister: Array<() => void> = [];
const mounted = new Set<TestRenderer.ReactTestRenderer>();
const originalDimensions = {
  window: Dimensions.get('window'),
  screen: Dimensions.get('screen'),
};

function registerTargets(keys: WalkthroughTargetKey[]) {
  for (const key of keys) {
    unregister.push(
      registerWalkthroughMeasurer(key, () =>
        Promise.resolve(TARGET_RECTS[key]),
      ),
    );
  }
}

beforeEach(() => {
  mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
  mockReducedMotion = false;
  Dimensions.set({
    window: { width: 393, height: 852, scale: 3, fontScale: 1 },
    screen: { width: 393, height: 852, scale: 3, fontScale: 1 },
  });
});

afterEach(() => {
  act(() => {
    for (const renderer of mounted) renderer.unmount();
  });
  mounted.clear();
  Dimensions.set(originalDimensions);
  for (const cleanup of unregister) cleanup();
  unregister = [];
  useWalkthroughStore.setState({
    visible: false,
    queued: false,
    request: null,
  });
  jest.restoreAllMocks();
});

function walkthroughElement() {
  return (
    <SafeAreaInsetsContext.Provider value={mockInsets}>
      <FirstRunWalkthrough />
    </SafeAreaInsetsContext.Provider>
  );
}

function scaledAdvanceHeight(
  renderer: TestRenderer.ReactTestRenderer,
  fontScale: number,
) {
  const button = renderer.root.findByType(Button);
  const label = button.findByType(Text);
  const labelStyle = StyleSheet.flatten(label.props.style);
  const contentStyle = StyleSheet.flatten(label.parent!.props.style);
  const buttonStyle = StyleSheet.flatten(
    button.findByType(PressableScale).props.style,
  );
  return Math.ceil(
    Math.max(
      buttonStyle.minHeight,
      Math.max(
        contentStyle.minHeight,
        labelStyle.lineHeight * fontScale +
          (contentStyle.paddingVertical ?? 0) * 2,
      ) +
        buttonStyle.borderWidth * 2,
    ),
  );
}

async function renderVisible() {
  useWalkthroughStore.setState({ visible: true });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(walkthroughElement());
    mounted.add(renderer);
  });
  return renderer;
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

async function pressByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const target = renderer.root.findAll(
    node => node.props.testID === testID && node.props.onPress !== undefined,
  )[0];
  expect(target).toBeDefined();
  await act(async () => target!.props.onPress());
}

describe('FirstRunWalkthrough (spotlight tour)', () => {
  it('renders nothing while the store is hidden', () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(walkthroughElement());
      mounted.add(renderer);
    });
    expect(
      renderer.root.findAll(n => n.props.testID === 'first-run-walkthrough'),
    ).toHaveLength(0);
  });

  it.each([
    { width: 375, height: 667, top: 20, bottom: 0 },
    { width: 393, height: 852, top: 59, bottom: 34 },
    { width: 320, height: 568, top: 20, bottom: 0 },
  ])(
    'contains oversized callout text and stacks full-width actions at $width × $height / 3.571x',
    async dimensions => {
      jest.spyOn(Dimensions, 'get').mockReturnValue({
        width: dimensions.width,
        height: dimensions.height,
        scale: 3,
        fontScale: 3.571,
      });
      mockInsets = {
        top: dimensions.top,
        bottom: dimensions.bottom,
        left: 0,
        right: 0,
      };
      mockReducedMotion = true;
      const rect = {
        x: (dimensions.width - 68) / 2,
        y: dimensions.height - dimensions.bottom - 94,
        width: 68,
        height: 68,
      };
      unregister.push(
        registerWalkthroughMeasurer('coach-fab', async () => rect),
      );
      const renderer = await renderVisible();
      const callout = renderer.root.findByProps({
        testID: 'walkthrough-callout',
      });
      const bounds = StyleSheet.flatten(callout.props.style);
      expect(bounds).toMatchObject({
        left: space.lg,
        width: dimensions.width - space.lg * 2,
      });
      expect(bounds.top).toBe(dimensions.top + space.lg);
      expect(bounds.maxHeight).toBe(rect.y - 7 - space.md - bounds.top);
      const viewportHeight =
        bounds.maxHeight -
        (bounds.paddingTop ?? space.lg) -
        (bounds.paddingBottom ?? space.md) -
        bounds.borderWidth * 2;
      expect(viewportHeight).toBeGreaterThanOrEqual(
        scaledAdvanceHeight(renderer, 3.571),
      );
      expect(bounds.top + bounds.maxHeight).toBeLessThanOrEqual(
        dimensions.height - dimensions.bottom - space.lg,
      );
      expect(bounds.maxHeight).toBeLessThan(1067.73);
      const scroll = callout.findByType(ScrollView);
      expect(scroll.props.scrollEnabled).not.toBe(false);
      expect(scroll.props.bounces).toBe(false);
      expect(scroll.props.contentInsetAdjustmentBehavior).toBe('never');
      expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({
        flexGrow: 0,
        flexShrink: 1,
        minHeight: 0,
      });
      const footer = renderer.root.findByProps({
        testID: 'walkthrough-controls',
      });
      const buttons = renderer.root.findByProps({
        testID: 'walkthrough-control-buttons',
      });
      expect(StyleSheet.flatten(footer.props.style)).toMatchObject({
        flexDirection: 'column',
        alignItems: 'stretch',
      });
      expect(StyleSheet.flatten(buttons.props.style)).toMatchObject({
        flexDirection: 'column',
        alignItems: 'stretch',
        maxWidth: '100%',
        minWidth: 0,
      });
      const skip = scroll.findAll(
        node => node.props.testID === 'walkthrough-skip' && node.props.onPress,
      )[0]!;
      expect(
        StyleSheet.flatten(skip.props.style).minHeight,
      ).toBeGreaterThanOrEqual(44);
      expect(
        scroll.findAll(
          node =>
            node.props.testID === 'walkthrough-advance' && node.props.onPress,
        ).length,
      ).toBeGreaterThan(0);
      for (const text of scroll.findAllByType(Text)) {
        expect(text.props.numberOfLines).toBeUndefined();
        expect(text.props.maxFontSizeMultiplier).toBeUndefined();
        expect(text.props.adjustsFontSizeToFit).not.toBe(true);
        expect(text.props.allowFontScaling).not.toBe(false);
      }
      expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[0]!.body);
      await pressByTestId(renderer, 'walkthrough-skip');
      expect(useWalkthroughStore.getState().visible).toBe(false);
      act(() => renderer.unmount());
    },
  );

  it.each([
    {
      width: 375,
      height: 667,
      top: 20,
      bottom: 0,
      y: 193,
      targetHeight: 248,
      below: true,
    },
    {
      width: 375,
      height: 667,
      top: 20,
      bottom: 0,
      y: 246,
      targetHeight: 260,
      below: false,
    },
    {
      width: 393,
      height: 852,
      top: 59,
      bottom: 34,
      y: 193,
      targetHeight: 399,
      below: true,
    },
    {
      width: 393,
      height: 852,
      top: 59,
      bottom: 34,
      y: 285,
      targetHeight: 345,
      below: false,
    },
  ])(
    'rejects a 60pt scroll slot for the full scaled CTA at $width × $height / below=$below and advances every step',
    async dimensions => {
      jest.spyOn(Dimensions, 'get').mockReturnValue({
        width: dimensions.width,
        height: dimensions.height,
        scale: 3,
        fontScale: 3.571,
      });
      mockInsets = {
        top: dimensions.top,
        bottom: dimensions.bottom,
        left: 0,
        right: 0,
      };
      mockReducedMotion = true;
      const targets = {
        'coach-fab': {
          x: 154,
          y: dimensions.height - dimensions.bottom - 94,
          width: 64,
          height: 64,
        },
        'rank-banner': {
          x: 24,
          y: dimensions.y,
          width: dimensions.width - 48,
          height: dimensions.targetHeight,
        },
        'home-streak': {
          x: dimensions.width - 24 - 56,
          y: dimensions.top + 4,
          width: 56,
          height: 32,
        },
        'tab-library': {
          x: 96,
          y: dimensions.height - dimensions.bottom - 54,
          width: 70,
          height: 54,
        },
        'tab-progress': {
          x: 236,
          y: dimensions.height - dimensions.bottom - 54,
          width: 70,
          height: 54,
        },
      };
      for (const step of WALKTHROUGH_STEPS) {
        unregister.push(
          registerWalkthroughMeasurer(
            step.targetKey,
            async () => targets[step.targetKey],
          ),
        );
      }
      const renderer = await renderVisible();
      expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
      expect(
        renderer.root.findByProps({ testID: 'ceremony-overlay' }).props
          .accessibilityViewIsModal,
      ).toBe(true);
      for (const [index, step] of WALKTHROUGH_STEPS.entries()) {
        expect(textContent(renderer)).toContain(step.headline);
        expect(textContent(renderer)).toContain(step.body);
        if (step.finePrint)
          expect(textContent(renderer)).toContain(step.finePrint);
        const callout = renderer.root.findByProps({
          testID: 'walkthrough-callout',
        });
        const bounds = StyleSheet.flatten(callout.props.style);
        const viewportHeight =
          bounds.maxHeight -
          (bounds.paddingTop ?? space.lg) -
          (bounds.paddingBottom ?? space.md) -
          bounds.borderWidth * 2;
        expect(scaledAdvanceHeight(renderer, 3.571)).toBe(97);
        expect(viewportHeight).toBeGreaterThanOrEqual(
          scaledAdvanceHeight(renderer, 3.571),
        );
        expect(bounds.top).toBeGreaterThanOrEqual(dimensions.top + space.lg);
        expect(bounds.top + bounds.maxHeight).toBeLessThanOrEqual(
          dimensions.height - dimensions.bottom - space.lg,
        );
        expect(callout.findByType(ScrollView).props.scrollEnabled).not.toBe(
          false,
        );
        expect(renderer.root.findByType(Button).props.label).toBe(
          index === WALKTHROUGH_STEPS.length - 1 ? 'Got it' : 'Next',
        );
        await pressByTestId(renderer, 'walkthrough-advance');
      }
      expect(useWalkthroughStore.getState().visible).toBe(false);
      act(() => renderer.unmount());
    },
  );

  it.each([1, 1.35, 2.64, 3.571])(
    'keeps a target-side card when its scroll viewport fits the full CTA at %sx',
    async fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale });
      mockInsets = { top: 20, bottom: 0, left: 0, right: 0 };
      const rect = { x: 24, y: 193, width: 327, height: 210 };
      unregister.push(
        registerWalkthroughMeasurer('rank-banner', async () => rect),
      );
      const renderer = await renderVisible();
      const callout = renderer.root.findByProps({
        testID: 'walkthrough-callout',
      });
      const bounds = StyleSheet.flatten(callout.props.style);
      expect(bounds).toMatchObject({ top: 427, maxHeight: 216 });
      const viewportHeight =
        bounds.maxHeight -
        (bounds.paddingTop ?? space.lg) -
        (bounds.paddingBottom ?? space.md) -
        bounds.borderWidth * 2;
      expect(viewportHeight).toBeGreaterThanOrEqual(
        scaledAdvanceHeight(renderer, fontScale),
      );
      await pressByTestId(renderer, 'walkthrough-skip');
      expect(useWalkthroughStore.getState().visible).toBe(false);
      act(() => renderer.unmount());
    },
  );

  it('keeps default placement and horizontal controls, and bounds a below-target callout without changing the target', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    let bounds = StyleSheet.flatten(
      renderer.root.findByProps({ testID: 'walkthrough-callout' }).props.style,
    );
    expect(bounds).toMatchObject({
      left: 24,
      width: 345,
      top: 83,
      maxHeight: 594,
    });
    expect(bounds.top + bounds.maxHeight).toBe(677);
    for (const testID of [
      'walkthrough-controls',
      'walkthrough-control-buttons',
    ]) {
      expect(
        StyleSheet.flatten(renderer.root.findByProps({ testID }).props.style)
          .flexDirection,
      ).toBe('row');
    }
    await pressByTestId(renderer, 'walkthrough-advance');
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
    bounds = StyleSheet.flatten(
      renderer.root.findByProps({ testID: 'walkthrough-callout' }).props.style,
    );
    expect(bounds).toMatchObject({ top: 240, maxHeight: 554 });
    expect(bounds.bottom).toBeUndefined();
    expect(bounds.top + bounds.maxHeight).toBe(852 - 34 - space.lg);
    act(() => renderer.unmount());
  });

  it('keeps controls scrollable when an oversized target leaves no usable arrow lane', async () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 3.571 });
    const rect = { x: 24, y: 80, width: 345, height: 650 };
    unregister.push(
      registerWalkthroughMeasurer('rank-banner', async () => rect),
    );
    const renderer = await renderVisible();
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
    const callout = renderer.root.findByProps({
      testID: 'walkthrough-callout',
    });
    const bounds = StyleSheet.flatten(callout.props.style);
    expect(bounds).toMatchObject({ top: 421, maxHeight: 373 });
    expect(bounds.top + bounds.maxHeight).toBe(852 - 34 - space.lg);
    expect(callout.findByType(ScrollView).props.scrollEnabled).not.toBe(false);
    await pressByTestId(renderer, 'walkthrough-skip');
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('uses an immediate overlay under reduced motion, still announces and advances every measured step', async () => {
    mockReducedMotion = true;
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'ceremony-overlay' }).props
        .accessibilityViewIsModal,
    ).toBe(true);
    for (const [index, step] of WALKTHROUGH_STEPS.entries()) {
      expect(announce).toHaveBeenLastCalledWith(
        expect.stringContaining(
          `Walkthrough, step ${index + 1} of ${WALKTHROUGH_STEPS.length}. ${step.headline}`,
        ),
      );
      await pressByTestId(renderer, 'walkthrough-advance');
    }
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('keeps the immediate overlay when reduced motion changes without resetting the current step', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'ceremony-overlay' }).props
        .accessibilityViewIsModal,
    ).toBe(true);
    await pressByTestId(renderer, 'walkthrough-advance');
    mockReducedMotion = true;
    await act(async () => renderer.update(walkthroughElement()));
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'ceremony-overlay' }).props
        .accessibilityViewIsModal,
    ).toBe(true);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
    await pressByTestId(renderer, 'walkthrough-skip');
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('anchors step one to the measured Coach button', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    const text = textContent(renderer);
    expect(text).toContain('START HERE');
    expect(text).toContain('Every read starts here.');
    expect(text).toContain('Skip');
  });

  it('walks every step in order and dismisses on the final CTA', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();

    for (const [index, step] of WALKTHROUGH_STEPS.entries()) {
      expect(textContent(renderer)).toContain(step.headline);
      const isLast = index === WALKTHROUGH_STEPS.length - 1;
      // Skip is offered on every step except the last, where only the
      // affirmative close remains.
      expect(textContent(renderer).includes('Skip')).toBe(!isLast);
      await pressByTestId(renderer, 'walkthrough-advance');
    }

    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('skips a step whose target is not on screen instead of pointing at nothing', async () => {
    registerTargets(['coach-fab', 'tab-library', 'tab-progress']);
    const renderer = await renderVisible();

    expect(textContent(renderer)).toContain('Every read starts here.');
    await pressByTestId(renderer, 'walkthrough-advance');

    // rank-banner is unregistered → the honesty step is skipped straight to
    // the Library step.
    const text = textContent(renderer);
    expect(text).toContain('Your reads live here.');
    expect(text).not.toContain('Only clear reads count.');
  });

  it('keeps an enlarged rank step whose visible area is meaningful even though its center is off-screen', async () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale: 3.571 });
    unregister.push(
      registerWalkthroughMeasurer('rank-banner', async () => ({
        x: 24,
        y: 320,
        width: 327,
        height: 850,
      })),
    );
    const renderer = await renderVisible();
    try {
      expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
      const callout = renderer.root.findByProps({
        testID: 'walkthrough-callout',
      });
      expect(StyleSheet.flatten(callout.props.style).maxHeight).toBeGreaterThan(
        97,
      );
      await pressByTestId(renderer, 'walkthrough-skip');
      expect(useWalkthroughStore.getState().visible).toBe(false);
    } finally {
      act(() => renderer.unmount());
    }
  });

  it('skips a step whose target is scrolled out of the viewport', async () => {
    registerTargets(['coach-fab', 'tab-library', 'tab-progress']);
    // The rank banner IS registered but measures above the screen — exactly
    // what a scrolled-down Home produces. Pointing there would spotlight
    // nothing, so the step must be skipped.
    unregister.push(
      registerWalkthroughMeasurer('rank-banner', () =>
        Promise.resolve({ x: 24, y: -300, width: 345, height: 96 }),
      ),
    );
    const renderer = await renderVisible();
    await pressByTestId(renderer, 'walkthrough-advance');
    // An off-screen (but registered) target exhausts the real measurement
    // retries before the step is skipped — wait them out.
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 950));
    });

    const text = textContent(renderer);
    expect(text).toContain('Your reads live here.');
    expect(text).not.toContain('Only clear reads count.');
  });

  it('dismisses when no target at all can be measured', async () => {
    const renderer = await renderVisible();
    expect(
      renderer.root.findAll(n => n.props.testID === 'walkthrough-advance'),
    ).toHaveLength(0);
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('states the honesty contract verbatim on the ratings step', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    await pressByTestId(renderer, 'walkthrough-advance');

    const text = textContent(renderer);
    expect(text).toContain('HONEST RATINGS');
    expect(text).toContain('Only clear reads count.');
    expect(text).toContain(
      'One validated rating free · Unscored attempts don’t count',
    );
  });

  it('skip dismisses immediately', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    await pressByTestId(renderer, 'walkthrough-skip');
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('backdrop tap dismisses — the tour never blocks input', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    const backdrop = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Dismiss walkthrough' &&
        node.props.onPress !== undefined,
    )[0];
    expect(backdrop).toBeDefined();
    await act(async () => backdrop!.props.onPress());
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });
});

const SE_WINDOW = { width: 375, height: 667, scale: 2, fontScale: 1.353 };
const SE_INSETS: EdgeInsets = { top: 20, bottom: 0, left: 0, right: 0 };
const SE_FRAME = { x: 0, y: 0, width: 375, height: 667 };
const SE_VIEWPORT = { x: 24, y: 44, width: 327, height: 599 };
const SE_TARGETS = {
  'coach-fab': { x: 155, y: 565, width: 64, height: 64 },
  'rank-banner': { x: 24, y: 140, width: 327, height: 200 },
  'home-streak': { x: 295, y: 24, width: 56, height: 32 },
  'tab-library': { x: 76, y: 613, width: 70, height: 54 },
  'tab-progress': { x: 226, y: 613, width: 70, height: 54 },
};

function layoutTree(insets: EdgeInsets = SE_INSETS) {
  return (
    <SafeAreaInsetsContext.Provider value={insets}>
      <FirstRunWalkthrough />
    </SafeAreaInsetsContext.Provider>
  );
}

async function renderLayout(insets: EdgeInsets = SE_INSETS) {
  useWalkthroughStore.getState().replay();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(layoutTree(insets));
    mounted.add(renderer);
  });
  return renderer;
}

function byTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(node => node.props.testID === testID)[0]!;
}

function layoutStyle(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return StyleSheet.flatten(byTestId(renderer, testID).props.style);
}

function registerLayoutTargets() {
  const measurers = {
    'coach-fab': jest.fn(async () => SE_TARGETS['coach-fab']),
    'rank-banner': jest.fn(async () => SE_TARGETS['rank-banner']),
    'home-streak': jest.fn(async () => SE_TARGETS['home-streak']),
    'tab-library': jest.fn(async () => SE_TARGETS['tab-library']),
    'tab-progress': jest.fn(async () => SE_TARGETS['tab-progress']),
  };
  for (const key of Object.keys(measurers) as WalkthroughTargetKey[]) {
    unregister.push(registerWalkthroughMeasurer(key, measurers[key]));
  }
  return measurers;
}

async function measureCallout(
  renderer: TestRenderer.ReactTestRenderer,
  bodyHeight: number,
  controlsHeight: number,
) {
  await act(async () => {
    const width = layoutStyle(renderer, 'walkthrough-callout').width - 50;
    byTestId(renderer, 'walkthrough-copy-content').props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width, height: bodyHeight } },
    });
    byTestId(renderer, 'walkthrough-controls').props.onLayout({
      nativeEvent: { layout: { x: 0, y: 0, width, height: controlsHeight } },
    });
  });
}

function spotlightPath(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root.findAll(node => node.props.fillRule === 'evenodd')[0]!
    .props.d;
}

describe('walkthrough safe viewport and measured callout geometry', () => {
  it('uses the full-window overlay safe area, including all four insets', () => {
    expect(walkthroughViewport(SE_FRAME, SE_WINDOW, SE_INSETS)).toEqual(
      SE_VIEWPORT,
    );
    expect(
      walkthroughViewport(
        { x: 0, y: 0, width: 667, height: 375 },
        { width: 667, height: 375 },
        { top: 0, bottom: 21, left: 44, right: 44 },
      ),
    ).toEqual({ x: 68, y: 24, width: 531, height: 306 });
  });

  it('intersects the actual overlay frame with the window before converting to local coordinates', () => {
    expect(
      walkthroughViewport(
        { x: 12, y: 30, width: 351, height: 600 },
        SE_WINDOW,
        { top: 20, bottom: 34, left: 0, right: 0 },
      ),
    ).toEqual({ x: 24, y: 24, width: 303, height: 552 });
    expect(
      walkthroughViewport(
        { x: 0, y: 0, width: 375, height: 900 },
        SE_WINDOW,
        SE_INSETS,
      ),
    ).toEqual(SE_VIEWPORT);
  });

  it('bounds the SE3 ratings callout and scroll budget instead of putting Next at y=767', () => {
    const layout = walkthroughCalloutLayout(
      SE_VIEWPORT,
      SE_TARGETS['rank-banner'],
      'rounded',
      { bodyHeight: 350, controlsHeight: 56 },
    );
    expect(layout).toMatchObject({
      left: 24,
      top: 364,
      width: 327,
      height: 279,
      maxHeight: 279,
      bodyMaxHeight: 165,
      below: true,
    });
    expect(layout.top + layout.maxHeight).toBe(643);
    expect(layout.bodyMaxHeight).toBeLessThan(350);
  });

  it('the daily-streak step spotlights the Home flame chip: callout below the top-bar target, arrow rising into it', () => {
    // The closing step (owner request 2026-09-10): the Consistency streak.
    const step = WALKTHROUGH_STEPS.at(-1)!;
    expect(step).toMatchObject({
      key: 'streak',
      targetKey: 'home-streak',
      shape: 'rounded',
      eyebrow: 'DAILY STREAK',
    });
    // Honest copy: a day is earned by finishing a read or a drill, never by
    // opening the app, and the flame opens the calendar / shields /
    // achievements — exactly what the shipping chip does.
    expect(step.body).toMatch(/finish a read or a drill/);
    expect(step.body).toMatch(/never for just opening the app/);
    expect(step.body).toMatch(/Tap the flame/);
    expect(step.body).toMatch(/Streak Shields and achievements/);

    const layout = walkthroughCalloutLayout(
      SE_VIEWPORT,
      SE_TARGETS['home-streak'],
      'rounded',
      { bodyHeight: 120, controlsHeight: 56 },
    );
    // A target in the top bar puts the card underneath it, with the arrow
    // lane between them, and the card stays inside the safe viewport.
    expect(layout.below).toBe(true);
    expect(layout.top).toBeGreaterThanOrEqual(
      SE_TARGETS['home-streak'].y + SE_TARGETS['home-streak'].height,
    );
    expect(layout.top + layout.height).toBeLessThanOrEqual(
      SE_VIEWPORT.y + SE_VIEWPORT.height,
    );
    // The arrow's head lands on the target, pointing up from the card.
    const hole = {
      x: SE_TARGETS['home-streak'].x + SE_TARGETS['home-streak'].width / 2,
      y: SE_TARGETS['home-streak'].y + SE_TARGETS['home-streak'].height + 8,
    };
    const arrow = arrowGeometry({ x: hole.x, y: layout.top }, hole);
    expect(arrow.shaft.startsWith(`M ${hole.x} ${layout.top}`)).toBe(true);
    expect(arrow.shaft.endsWith(`${hole.x} ${hole.y}`)).toBe(true);
    expect(arrow.head).toContain(`L ${hole.x} ${hole.y}`);
  });

  it.each([
    { bodyHeight: null, controlsHeight: null },
    { bodyHeight: 1100, controlsHeight: null },
    { bodyHeight: null, controlsHeight: 212 },
  ])(
    'keeps the target visible while callout measurements are incomplete: %o',
    measurements => {
      const layout = walkthroughCalloutLayout(
        SE_VIEWPORT,
        SE_TARGETS['rank-banner'],
        'rounded',
        measurements,
      );
      const height = measurements.controlsHeight === 212 ? 387 : 279;
      expect(layout).toMatchObject({
        top: 643 - height,
        height,
        maxHeight: height,
        scrollControls: true,
      });
    },
  );

  it('preserves a visible half of a viewport-filling target when no outside lane exists', () => {
    const layout = walkthroughCalloutLayout(
      SE_VIEWPORT,
      SE_VIEWPORT,
      'rounded',
      { bodyHeight: 1100, controlsHeight: 212 },
    );
    const targetCenter = SE_VIEWPORT.y + SE_VIEWPORT.height / 2;
    expect(
      layout.top > targetCenter || layout.top + layout.height < targetCenter,
    ).toBe(true);
    expect(layout.height).toBeLessThan(SE_VIEWPORT.height / 2);
    expect(layout.height).toBeGreaterThan(44);
    expect(layout.top).toBeGreaterThanOrEqual(SE_VIEWPORT.y);
    expect(layout.top + layout.height).toBeLessThanOrEqual(
      SE_VIEWPORT.y + SE_VIEWPORT.height,
    );
  });

  it('retains the full arrow lane when the measured card fits', () => {
    const layout = walkthroughCalloutLayout(
      SE_VIEWPORT,
      { x: 24, y: 100, width: 327, height: 96 },
      'rounded',
      { bodyHeight: 120, controlsHeight: 56 },
    );
    expect(layout.top).toBe(100 + 96 + 8 + 92);
    expect(layout.height).toBe(120 + 56 + 58);
    expect(layout.below).toBe(true);
  });

  it('scrolls the whole card on the roomier side in landscape rather than obscuring the target with a full-screen card', () => {
    const viewport = { x: 68, y: 24, width: 531, height: 306 };
    const layout = walkthroughCalloutLayout(
      viewport,
      { x: 200, y: 165, width: 70, height: 54 },
      'rounded',
      { bodyHeight: 900, controlsHeight: 104 },
    );
    expect(layout).toMatchObject({
      left: 68,
      top: 24,
      width: 531,
      height: 152,
      maxHeight: 152,
      scrollControls: true,
    });
    expect(layout.top + layout.height).toBeLessThanOrEqual(165 + 54 / 2 - 16);
  });

  it.each([
    ['XXXL', 350, 56, 1.353],
    ['AXXXXL', 1100, 168, 3.571],
  ])(
    'keeps the SE3 %s spotlight center uncovered and the measured footer inside the card',
    (_label, bodyHeight, controlsHeight, fontScale) => {
      const layout = walkthroughCalloutLayout(
        SE_VIEWPORT,
        SE_TARGETS['rank-banner'],
        'rounded',
        { bodyHeight, controlsHeight, minimumBodyHeight: 27 * fontScale },
      );
      expect(layout.top).toBeGreaterThanOrEqual(
        SE_TARGETS['rank-banner'].y + SE_TARGETS['rank-banner'].height / 2 + 8,
      );
      expect(layout.bodyMaxHeight).toBeGreaterThanOrEqual(27 * fontScale);
      expect(layout.top + layout.height).toBeLessThanOrEqual(643);
      expect(layout.scrollControls).toBe(false);
      const controlsBottom = layout.top + layout.height - 17;
      const controlsTop = controlsBottom - controlsHeight;
      expect(controlsTop).toBeGreaterThanOrEqual(layout.top + 25 + 44 + 16);
      expect(controlsBottom).toBeLessThanOrEqual(643 - 17);
      expect(layout.bodyMaxHeight + controlsHeight + 58).toBeLessThanOrEqual(
        layout.height,
      );
    },
  );

  it('reserves a full Dynamic Type line and the wrapped actions while leaving the target center visible', () => {
    const layout = walkthroughCalloutLayout(
      SE_VIEWPORT,
      SE_TARGETS['rank-banner'],
      'rounded',
      { bodyHeight: 1100, controlsHeight: 212, minimumBodyHeight: 27 * 3.571 },
    );
    expect(layout).toMatchObject({
      top: 256,
      height: 387,
      bodyMaxHeight: 117,
      scrollControls: false,
    });
    expect(layout.bodyMaxHeight).toBeGreaterThanOrEqual(27 * 3.571);
    expect(layout.top).toBeGreaterThan(
      SE_TARGETS['rank-banner'].y + SE_TARGETS['rank-banner'].height / 2,
    );
    const controlsBottom = layout.top + layout.height - 17;
    expect(controlsBottom - 212).toBeGreaterThan(layout.top);
    expect(controlsBottom).toBeLessThan(643);
  });

  it.each([320, 700])(
    'does not pin an oversized %spt action row beyond the small-screen card',
    controlsHeight => {
      const layout = walkthroughCalloutLayout(
        SE_VIEWPORT,
        SE_TARGETS['rank-banner'],
        'rounded',
        { bodyHeight: 1100, controlsHeight },
      );
      expect(layout).toMatchObject({
        top: 256,
        height: 387,
        maxHeight: 387,
        scrollControls: true,
      });
    },
  );

  it('clamps both edges for measured sizes across portrait, landscape, and offset safe viewports', () => {
    for (const viewport of [
      SE_VIEWPORT,
      { x: 68, y: 24, width: 531, height: 306 },
      { x: 24, y: 83, width: 382, height: 791 },
    ]) {
      for (const bodyHeight of [80, 350, 900, 1800]) {
        for (const controlsHeight of [56, 104, 168]) {
          for (const y of [0, viewport.height * 0.5, viewport.height - 10]) {
            const layout = walkthroughCalloutLayout(
              viewport,
              { x: viewport.x, y, width: 70, height: 54 },
              'rounded',
              { bodyHeight, controlsHeight },
            );
            expect(layout.left).toBeGreaterThanOrEqual(viewport.x);
            expect(layout.left + layout.width).toBeLessThanOrEqual(
              viewport.x + viewport.width,
            );
            expect(layout.top).toBeGreaterThanOrEqual(viewport.y);
            expect(layout.top + layout.maxHeight).toBeLessThanOrEqual(
              viewport.y + viewport.height,
            );
            expect(layout.height).toBeLessThanOrEqual(layout.maxHeight);
            if (!layout.scrollControls) {
              expect(layout.bodyMaxHeight).toBeGreaterThan(0);
              expect(
                layout.bodyMaxHeight + controlsHeight + 58,
              ).toBeLessThanOrEqual(layout.maxHeight);
            } else {
              expect(layout.height).toBeGreaterThanOrEqual(44);
            }
          }
        }
      }
    }
  });
});

describe('FirstRunWalkthrough adaptive layout', () => {
  beforeEach(() => {
    Dimensions.set({ window: SE_WINDOW, screen: SE_WINDOW });
  });

  it('keeps a bounded card before measurements arrive, then scrolls all copy independently of reachable actions', async () => {
    registerLayoutTargets();
    const renderer = await renderLayout();
    await pressByTestId(renderer, 'walkthrough-advance');
    const request = useWalkthroughStore.getState().request;
    expect(layoutStyle(renderer, 'walkthrough-callout')).toMatchObject({
      left: 24,
      top: 364,
      width: 327,
      maxHeight: 279,
    });

    await measureCallout(renderer, 350, 56);

    const callout = layoutStyle(renderer, 'walkthrough-callout');
    expect(callout).toMatchObject({ top: 364, maxHeight: 279 });
    expect(callout.height).toBe(279);
    expect(callout.overflow).not.toBe('hidden');
    const copy = renderer.root
      .findAllByType(ScrollView)
      .find(node => node.props.testID === 'walkthrough-copy')!;
    expect(copy).toBeDefined();
    expect(StyleSheet.flatten(copy.props.style)).toMatchObject({
      minHeight: 0,
      flexShrink: 1,
      maxHeight: 165,
    });
    expect(copy.props.scrollEnabled).not.toBe(false);
    expect(copy.props.showsVerticalScrollIndicator).toBe(true);
    expect(copy.props.contentInsetAdjustmentBehavior).toBe('never');
    expect(
      copy.findAll(node => node.props.testID === 'walkthrough-advance'),
    ).toHaveLength(0);
    expect(
      copy.findAll(node => node.props.testID === 'walkthrough-skip'),
    ).toHaveLength(0);
    expect(layoutStyle(renderer, 'walkthrough-controls')).toMatchObject({
      flexShrink: 0,
      flexWrap: 'wrap',
    });
    expect(layoutStyle(renderer, 'walkthrough-control-buttons').flexWrap).toBe(
      'wrap',
    );
    const skipStyle = layoutStyle(renderer, 'walkthrough-skip');
    expect(skipStyle.minHeight).toBeGreaterThanOrEqual(44);
    expect(skipStyle.minWidth).toBeGreaterThanOrEqual(44);
    for (const text of copy.findAll(node => String(node.type) === 'Text')) {
      expect(text.props.allowFontScaling).not.toBe(false);
      expect(text.props.maxFontSizeMultiplier).toBeUndefined();
      expect(text.props.numberOfLines).toBeUndefined();
    }
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.body);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.finePrint);
    expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
    expect(useWalkthroughStore.getState().request).toBe(request);
    await pressByTestId(renderer, 'walkthrough-advance');
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[2]!.headline);
    await pressByTestId(renderer, 'walkthrough-skip');
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('uses a reflowed, multi-row footer height at accessibility sizes rather than a fixed action height', async () => {
    const dimensions = { ...SE_WINDOW, fontScale: 3.571 };
    Dimensions.set({ window: dimensions, screen: dimensions });
    registerLayoutTargets();
    const renderer = await renderLayout();
    await pressByTestId(renderer, 'walkthrough-advance');
    await measureCallout(renderer, 1100, 168);
    const callout = layoutStyle(renderer, 'walkthrough-callout');
    expect(callout).toMatchObject({ top: 256, height: 387, maxHeight: 387 });
    expect(layoutStyle(renderer, 'walkthrough-copy').maxHeight).toBe(161);
    expect(
      layoutStyle(renderer, 'walkthrough-copy').maxHeight,
    ).toBeGreaterThanOrEqual(27 * dimensions.fontScale);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.finePrint);
    await act(async () => {
      byTestId(renderer, 'walkthrough-callout').props.onAccessibilityEscape();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it.each([
    ['small portrait XXXL', SE_WINDOW, SE_INSETS, 320],
    ['AXXXXL portrait', { ...SE_WINDOW, fontScale: 3.571 }, SE_INSETS, 320],
    [
      'AXXXXL landscape',
      { width: 667, height: 375, scale: 2, fontScale: 3.571 },
      { top: 0, bottom: 21, left: 44, right: 44 },
      320,
    ],
  ])(
    'makes oversized actions scroll-reachable without clipping them at %s',
    async (_label, dimensions, insets, controlsHeight) => {
      registerLayoutTargets();
      const renderer = await renderLayout(insets);
      await pressByTestId(renderer, 'walkthrough-advance');
      await act(async () =>
        Dimensions.set({ window: dimensions, screen: dimensions }),
      );
      await measureCallout(renderer, 1100, controlsHeight);
      const callout = layoutStyle(renderer, 'walkthrough-callout');
      expect(callout.top).toBeGreaterThanOrEqual(insets.top + 24);
      expect(callout.top + callout.height).toBeLessThanOrEqual(
        dimensions.height - insets.bottom - 24,
      );
      const overflow = renderer.root
        .findAllByType(ScrollView)
        .find(node => node.props.testID === 'walkthrough-overflow');
      expect(overflow).toBeDefined();
      expect(overflow!.props.scrollEnabled).not.toBe(false);
      expect(overflow!.props.showsVerticalScrollIndicator).toBe(true);
      expect(
        StyleSheet.flatten(overflow!.props.style).maxHeight,
      ).toBeLessThanOrEqual(callout.height - 2);
      expect(
        overflow!.findAll(node => node.props.testID === 'walkthrough-advance')
          .length,
      ).toBeGreaterThan(0);
      expect(
        overflow!.findAll(node => node.props.testID === 'walkthrough-skip')
          .length,
      ).toBeGreaterThan(0);
      expect(overflow!.findAllByType(ScrollView)).toHaveLength(1);
      const controls = layoutStyle(renderer, 'walkthrough-controls');
      expect(controls.flexShrink).toBe(0);
      expect(controls.height).toBeUndefined();
      expect(controls.maxHeight).toBeUndefined();
      for (const text of overflow!.findAll(
        node => String(node.type) === 'Text',
      )) {
        expect(text.props.allowFontScaling).not.toBe(false);
        expect(text.props.maxFontSizeMultiplier).toBeUndefined();
        expect(text.props.numberOfLines).toBeUndefined();
        expect(text.props.adjustsFontSizeToFit).not.toBe(true);
      }
      await pressByTestId(renderer, 'walkthrough-skip');
      expect(useWalkthroughStore.getState().visible).toBe(false);
    },
  );

  it('ignores content and action heights delivered for an obsolete card width', async () => {
    registerLayoutTargets();
    const renderer = await renderLayout();
    await pressByTestId(renderer, 'walkthrough-advance');
    await act(async () => {
      const dimensions = { ...SE_WINDOW, width: 430 };
      Dimensions.set({ window: dimensions, screen: dimensions });
    });
    await measureCallout(renderer, 1100, 168);
    const expected = layoutStyle(renderer, 'walkthrough-callout');
    const expectedBody = layoutStyle(renderer, 'walkthrough-copy');
    await act(async () => {
      byTestId(renderer, 'walkthrough-copy-content').props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 277, height: 80 } },
      });
      byTestId(renderer, 'walkthrough-controls').props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 277, height: 44 } },
      });
    });
    expect(layoutStyle(renderer, 'walkthrough-callout')).toEqual(expected);
    expect(layoutStyle(renderer, 'walkthrough-copy')).toEqual(expectedBody);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
  });

  it('rejects old native host-layout events after a font-scale ABA change', async () => {
    const hostCallbacks: Array<
      (x: number, y: number, width: number, height: number) => void
    > = [];
    jest
      .spyOn(View.prototype as HostInstance, 'measureInWindow')
      .mockImplementation(callback => {
        hostCallbacks.push(callback);
      });
    registerLayoutTargets();
    const renderer = await renderLayout();
    await pressByTestId(renderer, 'walkthrough-advance');
    const request = useWalkthroughStore.getState().request;
    const oldLayout = byTestId(renderer, 'first-run-walkthrough').props
      .onLayout;
    for (const fontScale of [3.571, SE_WINDOW.fontScale]) {
      await act(async () => {
        const dimensions = { ...SE_WINDOW, fontScale };
        Dimensions.set({ window: dimensions, screen: dimensions });
      });
    }
    await act(async () =>
      hostCallbacks[hostCallbacks.length - 1]!(12, 30, 351, 600),
    );
    const expected = layoutStyle(renderer, 'walkthrough-callout');
    const expectedSpotlight = spotlightPath(renderer);
    const count = hostCallbacks.length;
    await act(async () => {
      oldLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 299, height: 550 } },
      });
      hostCallbacks[0]!(0, 0, 375, 667);
    });
    expect(hostCallbacks).toHaveLength(count);
    expect(layoutStyle(renderer, 'walkthrough-callout')).toEqual(expected);
    expect(spotlightPath(renderer)).toBe(expectedSpotlight);
    expect(useWalkthroughStore.getState().request).toBe(request);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
  });

  it.each<[string, Partial<typeof SE_WINDOW>, Partial<EdgeInsets>]>([
    ['fontScale', { fontScale: 3.571 }, {}],
    ['pixel scale', { scale: 3 }, {}],
    ['width', { width: 430 }, {}],
    ['height', { height: 600 }, {}],
    ['landscape', { width: 667, height: 375 }, {}],
    ['top inset', {}, { top: 59 }],
    ['bottom inset', {}, { bottom: 34 }],
    ['left inset', {}, { left: 44 }],
    ['right inset', {}, { right: 44 }],
  ])(
    'remeasures the current target on %s changes without resetting progress or request identity',
    async (_label, sizeChange, insetChange) => {
      const measurers = registerLayoutTargets();
      const renderer = await renderLayout();
      await pressByTestId(renderer, 'walkthrough-advance');
      const request = useWalkthroughStore.getState().request;
      expect(request).not.toBeNull();
      expect(measurers['rank-banner']).toHaveBeenCalledTimes(1);
      await act(async () => {
        const dimensions = { ...SE_WINDOW, ...sizeChange };
        Dimensions.set({ window: dimensions, screen: dimensions });
        renderer.update(layoutTree({ ...SE_INSETS, ...insetChange }));
      });
      expect(measurers['rank-banner']).toHaveBeenCalledTimes(2);
      expect(measurers['coach-fab']).toHaveBeenCalledTimes(1);
      expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
      expect(useWalkthroughStore.getState().request).toBe(request);
      expect(
        layoutStyle(renderer, 'walkthrough-callout').top,
      ).toBeGreaterThanOrEqual((insetChange.top ?? SE_INSETS.top) + 24);
      await measureCallout(renderer, 1100, 168);
      const callout = layoutStyle(renderer, 'walkthrough-callout');
      expect(callout.top + callout.maxHeight).toBeLessThanOrEqual(
        (sizeChange.height ?? SE_WINDOW.height) -
          (insetChange.bottom ?? 0) -
          24,
      );
    },
  );

  it('remeasures against the actual laid-out overlay size rather than the window estimate', async () => {
    const measurers = registerLayoutTargets();
    const renderer = await renderLayout();
    await pressByTestId(renderer, 'walkthrough-advance');
    const request = useWalkthroughStore.getState().request;
    await act(async () => {
      byTestId(renderer, 'first-run-walkthrough').props.onLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 343, height: 600 } },
      });
    });
    expect(measurers['rank-banner']).toHaveBeenCalledTimes(2);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
    expect(layoutStyle(renderer, 'walkthrough-callout')).toMatchObject({
      left: 24,
      top: 364,
      width: 295,
      maxHeight: 212,
    });
    expect(useWalkthroughStore.getState().request).toBe(request);
  });

  it.each([
    { x: 24, y: 60, width: 327, height: 96 },
    { x: 24, y: -1000, width: 327, height: 200 },
  ])(
    'ignores a stale target result from an earlier font layout while keeping the current step: %o',
    async staleRect => {
      const measurers = registerLayoutTargets();
      const renderer = await renderLayout();
      await pressByTestId(renderer, 'walkthrough-advance');
      const request = useWalkthroughStore.getState().request;
      let resolveOld!: (rect: (typeof SE_TARGETS)['rank-banner']) => void;
      measurers['rank-banner'].mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveOld = resolve;
          }),
      );
      await act(async () => {
        const dimensions = { ...SE_WINDOW, fontScale: 2 };
        Dimensions.set({ window: dimensions, screen: dimensions });
      });
      expect(byTestId(renderer, 'walkthrough-measuring')).toBeDefined();
      measurers['rank-banner'].mockResolvedValueOnce({
        x: 24,
        y: 220,
        width: 327,
        height: 152,
      });
      await act(async () => {
        const dimensions = { ...SE_WINDOW, fontScale: 3.571 };
        Dimensions.set({ window: dimensions, screen: dimensions });
      });
      expect(measurers['rank-banner']).toHaveBeenCalledTimes(3);
      const expectedSpotlight = spotlightPath(renderer);
      expect(expectedSpotlight).toContain('M 36 212');
      await act(async () => {
        resolveOld(staleRect);
      });
      expect(spotlightPath(renderer)).toBe(expectedSpotlight);
      expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
      expect(useWalkthroughStore.getState().request).toBe(request);
    },
  );

  it('remeasures grown and shrunk copy without accepting old font-layout callbacks or restarting the tour', async () => {
    const measurers = registerLayoutTargets();
    const renderer = await renderLayout();
    await pressByTestId(renderer, 'walkthrough-advance');
    await measureCallout(renderer, 350, 56);
    const request = useWalkthroughStore.getState().request;
    const oldBodyLayout = byTestId(renderer, 'walkthrough-copy-content').props
      .onLayout;
    const oldControlsLayout = byTestId(renderer, 'walkthrough-controls').props
      .onLayout;
    await act(async () => {
      const dimensions = { ...SE_WINDOW, fontScale: 3.571 };
      Dimensions.set({ window: dimensions, screen: dimensions });
    });
    await measureCallout(renderer, 1100, 320);
    const largeCallout = layoutStyle(renderer, 'walkthrough-callout');
    expect(byTestId(renderer, 'walkthrough-overflow')).toBeDefined();
    await act(async () => {
      oldBodyLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 277, height: 80 } },
      });
      oldControlsLayout({
        nativeEvent: { layout: { x: 0, y: 0, width: 277, height: 44 } },
      });
    });
    expect(layoutStyle(renderer, 'walkthrough-callout')).toEqual(largeCallout);
    expect(byTestId(renderer, 'walkthrough-overflow')).toBeDefined();
    await act(async () =>
      Dimensions.set({ window: SE_WINDOW, screen: SE_WINDOW }),
    );
    await measureCallout(renderer, 350, 56);
    expect(byTestId(renderer, 'walkthrough-overflow')).toBeUndefined();
    expect(layoutStyle(renderer, 'walkthrough-copy').maxHeight).toBe(165);
    expect(layoutStyle(renderer, 'walkthrough-callout')).toMatchObject({
      top: 364,
      height: 279,
    });
    expect(measurers['rank-banner']).toHaveBeenCalledTimes(3);
    expect(measurers['coach-fab']).toHaveBeenCalledTimes(1);
    expect(useWalkthroughStore.getState().request).toBe(request);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
    await pressByTestId(renderer, 'walkthrough-advance');
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[2]!.headline);
  });

  it.each([
    ['XXXL portrait', SE_WINDOW, SE_INSETS],
    ['AXXXXL portrait', { ...SE_WINDOW, fontScale: 3.571 }, SE_INSETS],
    [
      'AXXXXL landscape',
      { width: 667, height: 375, scale: 2, fontScale: 3.571 },
      { top: 0, bottom: 21, left: 44, right: 44 },
    ],
  ])(
    'keeps the waiting Skip outside scroll overflow and inside the safe viewport at %s',
    async (_label, dimensions, insets) => {
      Dimensions.set({ window: dimensions, screen: dimensions });
      unregister.push(
        registerWalkthroughMeasurer('coach-fab', () => new Promise(() => {})),
      );
      const renderer = await renderLayout(insets);
      const waiting = layoutStyle(renderer, 'walkthrough-measuring');
      expect(waiting).toMatchObject({
        top: insets.top + 24,
        bottom: insets.bottom + 24,
        left: insets.left + 24,
        width: dimensions.width - insets.left - insets.right - 48,
      });
      const copy = renderer.root
        .findAllByType(ScrollView)
        .find(node => node.props.testID === 'walkthrough-measuring-copy')!;
      expect(copy).toBeDefined();
      expect(
        copy.findAll(node => node.props.testID === 'walkthrough-skip'),
      ).toHaveLength(0);
      expect(
        layoutStyle(renderer, 'walkthrough-measuring-controls').flexShrink,
      ).toBe(0);
      expect(textContent(renderer)).toContain('Finding this part of the app');
      await pressByTestId(renderer, 'walkthrough-skip');
      expect(useWalkthroughStore.getState().visible).toBe(false);
    },
  );
});

describe('arrowGeometry', () => {
  it('ends the arrowhead exactly at the target point', () => {
    const { head } = arrowGeometry({ x: 100, y: 500 }, { x: 196, y: 380 });
    expect(head).toContain('L 196 380');
  });

  it('draws a shaft from the callout to the target', () => {
    const { shaft } = arrowGeometry({ x: 100, y: 500 }, { x: 196, y: 380 });
    expect(shaft.startsWith('M 100 500')).toBe(true);
    expect(shaft.endsWith('196 380')).toBe(true);
  });
});
