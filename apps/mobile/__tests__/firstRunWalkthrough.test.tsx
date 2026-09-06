import React from 'react';
import {
  AccessibilityInfo,
  Dimensions,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

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
  'tab-library': { x: 96, y: 760, width: 70, height: 54 },
  'tab-progress': { x: 236, y: 760, width: 70, height: 54 },
};

let unregister: Array<() => void> = [];

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
  jest
    .spyOn(Dimensions, 'get')
    .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 1 });
});

afterEach(() => {
  for (const cleanup of unregister) cleanup();
  unregister = [];
  useWalkthroughStore.setState({ visible: false });
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
        accessibilityViewIsModal: true,
      });
      const bounds = StyleSheet.flatten(callout.props.style);
      expect(bounds).toMatchObject({ left: space.lg, right: space.lg });
      expect(bounds.bottom).toBe(dimensions.height - (rect.y - 7 - 92));
      expect(bounds.maxHeight).toBe(
        dimensions.height - bounds.bottom - dimensions.top - space.lg,
      );
      const viewportHeight =
        bounds.maxHeight -
        bounds.paddingTop -
        bounds.paddingBottom -
        bounds.borderWidth * 2;
      expect(viewportHeight).toBeGreaterThanOrEqual(
        scaledAdvanceHeight(renderer, 3.571),
      );
      expect(dimensions.height - bounds.bottom - bounds.maxHeight).toBe(
        dimensions.top + space.lg,
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
      expect(renderer.root.findByType(Modal).props.animationType).toBe('none');
      for (const [index, step] of WALKTHROUGH_STEPS.entries()) {
        expect(textContent(renderer)).toContain(step.headline);
        expect(textContent(renderer)).toContain(step.body);
        if (step.finePrint)
          expect(textContent(renderer)).toContain(step.finePrint);
        const callout = renderer.root.findByProps({
          accessibilityViewIsModal: true,
        });
        const bounds = StyleSheet.flatten(callout.props.style);
        const viewportHeight =
          bounds.maxHeight -
          bounds.paddingTop -
          bounds.paddingBottom -
          bounds.borderWidth * 2;
        expect(scaledAdvanceHeight(renderer, 3.571)).toBe(97);
        expect(viewportHeight).toBeGreaterThanOrEqual(
          scaledAdvanceHeight(renderer, 3.571),
        );
        if (step.targetKey === 'rank-banner') {
          expect(bounds.maxHeight).toBe(
            dimensions.height -
              dimensions.top -
              dimensions.bottom -
              space.lg * 2,
          );
          if (dimensions.below) {
            expect(bounds.top).toBe(dimensions.top + space.lg);
            expect(bounds.bottom).toBeUndefined();
          } else {
            expect(bounds.bottom).toBe(dimensions.bottom + space.lg);
            expect(bounds.top).toBeUndefined();
          }
        }
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
        accessibilityViewIsModal: true,
      });
      const bounds = StyleSheet.flatten(callout.props.style);
      expect(bounds).toMatchObject({ top: 503, maxHeight: 140 });
      const viewportHeight =
        bounds.maxHeight -
        bounds.paddingTop -
        bounds.paddingBottom -
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
      renderer.root.findByProps({ accessibilityViewIsModal: true }).props.style,
    );
    expect(bounds).toMatchObject({
      left: 24,
      right: 24,
      bottom: 251,
      maxHeight: 518,
    });
    expect(bounds.top).toBeUndefined();
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
      renderer.root.findByProps({ accessibilityViewIsModal: true }).props.style,
    );
    expect(bounds).toMatchObject({ top: 316, maxHeight: 478 });
    expect(bounds.bottom).toBeUndefined();
    expect(316 + bounds.maxHeight).toBe(852 - 34 - space.lg);
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
      accessibilityViewIsModal: true,
    });
    const bounds = StyleSheet.flatten(callout.props.style);
    expect(bounds).toMatchObject({ top: 83, maxHeight: 711 });
    expect(bounds.top + bounds.maxHeight).toBe(852 - 34 - space.lg);
    expect(callout.findByType(ScrollView).props.scrollEnabled).not.toBe(false);
    await pressByTestId(renderer, 'walkthrough-skip');
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('uses no modal fade under reduced motion, still announces and advances every measured step', async () => {
    mockReducedMotion = true;
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    expect(renderer.root.findByType(Modal).props.animationType).toBe('none');
    for (const [index, step] of WALKTHROUGH_STEPS.entries()) {
      expect(announce).toHaveBeenLastCalledWith(
        expect.stringContaining(
          `Walkthrough, step ${index + 1} of 4. ${step.headline}`,
        ),
      );
      await pressByTestId(renderer, 'walkthrough-advance');
    }
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('updates the modal presentation when reduced motion changes without resetting the current step', async () => {
    registerTargets(Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]);
    const renderer = await renderVisible();
    expect(renderer.root.findByType(Modal).props.animationType).toBe('fade');
    await pressByTestId(renderer, 'walkthrough-advance');
    mockReducedMotion = true;
    await act(async () => renderer.update(walkthroughElement()));
    expect(renderer.root.findByType(Modal).props.animationType).toBe('none');
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
        accessibilityViewIsModal: true,
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
      'Two validated ratings free · Unscored attempts don’t count',
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
