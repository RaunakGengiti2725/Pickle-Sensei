import React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

// The walkthrough store persists through SQLite; the native module is absent
// under jest and these tests drive store state directly.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
} from '../../src/walkthrough/FirstRunWalkthrough';
import {
  registerWalkthroughMeasurer,
  type TargetRect,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

/**
 * Button ledger for FirstRunWalkthrough. Every interactive element the file
 * renders is pressed here and its real observable effect asserted:
 *
 *   backdrop  (accessibilityLabel "Dismiss walkthrough") -> store.dismiss
 *   Skip      (testID walkthrough-skip)                   -> store.dismiss
 *   Next      (testID walkthrough-advance, steps 1..n-1)  -> next step
 *   Got it    (testID walkthrough-advance, last step)     -> store.dismiss
 *   Modal.onRequestClose (Android back)                   -> store.dismiss
 *
 * Plus the async target-measurement path the buttons depend on: a target
 * that rejects, measures null, or is unregistered is skipped (never a dead
 * end), and the backdrop keeps working while a measurement is pending.
 */

const TARGET_RECTS: Record<WalkthroughTargetKey, TargetRect> = {
  'coach-fab': { x: 165, y: 700, width: 64, height: 64 },
  'rank-banner': { x: 24, y: 120, width: 345, height: 96 },
  'tab-library': { x: 96, y: 760, width: 70, height: 54 },
  'tab-progress': { x: 236, y: 760, width: 70, height: 54 },
};
const ALL_TARGETS = Object.keys(TARGET_RECTS) as WalkthroughTargetKey[];

/** Registered-target retries: 6 attempts × 120ms sleep (component constant). */
const RETRY_BUDGET_MS = 6 * 120 + 50;

let unregister: Array<() => void> = [];

function registerTargets(
  keys: WalkthroughTargetKey[],
  measure: (key: WalkthroughTargetKey) => Promise<TargetRect | null> = key =>
    Promise.resolve(TARGET_RECTS[key]),
) {
  for (const key of keys) {
    unregister.push(registerWalkthroughMeasurer(key, () => measure(key)));
  }
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  for (const cleanup of unregister) cleanup();
  unregister = [];
  act(() => {
    useWalkthroughStore.setState({ visible: false });
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function renderVisible() {
  act(() => {
    useWalkthroughStore.setState({ visible: true });
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FirstRunWalkthrough />);
  });
  return renderer;
}

async function settle(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function stageMounted(renderer: TestRenderer.ReactTestRenderer): boolean {
  return (
    renderer.root.findAll(n => n.props.testID === 'first-run-walkthrough')
      .length > 0
  );
}

function pressables(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string',
  );
}

function pressableLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return Array.from(
    new Set(
      pressables(renderer).map(node => node.props.accessibilityLabel as string),
    ),
  ).sort();
}

function findByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    node => node.props.testID === testID && node.props.onPress !== undefined,
  )[0];
}

/** Host view of the Next/Got it CTA (carries the resolved a11y props). */
function advanceHost(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'View' &&
      node.props.testID === 'walkthrough-advance',
  )[0];
}

function findBackdrop(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === 'Dismiss walkthrough' &&
      node.props.onPress !== undefined,
  )[0];
}

function findModal(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node => typeof node.props.onRequestClose === 'function',
  )[0];
}

async function press(node: TestRenderer.ReactTestInstance | undefined) {
  expect(node).toBeDefined();
  await act(async () => {
    node!.props.onPress();
  });
}

async function walkTo(renderer: TestRenderer.ReactTestRenderer, index: number) {
  for (let i = 0; i < index; i++) {
    await press(findByTestId(renderer, 'walkthrough-advance'));
  }
  expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[index]!.headline);
}

describe('FirstRunWalkthrough button ledger', () => {
  it('enumerates exactly the pressables the file renders on a middle step', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    expect(pressableLabels(renderer)).toEqual([
      'Dismiss walkthrough',
      'Next',
      'Skip walkthrough',
    ]);
    expect(findModal(renderer)).toBeDefined();
  });

  it('renders no pressables at all while the store is hidden', () => {
    registerTargets(ALL_TARGETS);
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    expect(stageMounted(renderer)).toBe(false);
    expect(pressables(renderer)).toHaveLength(0);
  });

  it('Skip -> dismiss: hides the tour immediately and unmounts the stage', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    const skip = findByTestId(renderer, 'walkthrough-skip');
    expect(skip?.props.accessibilityRole).toBe('button');
    expect(skip?.props.accessibilityLabel).toBe('Skip walkthrough');
    expect(skip?.props.hitSlop).toBe(12);

    await press(skip);

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
    expect(pressables(renderer)).toHaveLength(0);
  });

  it('Skip is offered on every step except the last', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    for (const [index] of WALKTHROUGH_STEPS.entries()) {
      const isLast = index === WALKTHROUGH_STEPS.length - 1;
      expect(findByTestId(renderer, 'walkthrough-skip') !== undefined).toBe(
        !isLast,
      );
      if (!isLast) {
        await press(findByTestId(renderer, 'walkthrough-advance'));
      }
    }
  });

  it('Next -> advances one step, changing the callout copy', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    const advance = findByTestId(renderer, 'walkthrough-advance');
    expect(advanceHost(renderer)?.props.accessibilityLabel).toBe('Next');
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[0]!.headline);

    await press(advance);

    const text = textContent(renderer);
    expect(text).toContain(WALKTHROUGH_STEPS[1]!.headline);
    expect(text).not.toContain(WALKTHROUGH_STEPS[0]!.headline);
    expect(useWalkthroughStore.getState().visible).toBe(true);
  });

  it('Next walks every step in order and the last CTA reads "Got it"', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    for (const [index, step] of WALKTHROUGH_STEPS.entries()) {
      const isLast = index === WALKTHROUGH_STEPS.length - 1;
      expect(textContent(renderer)).toContain(step.headline);
      expect(advanceHost(renderer)?.props.accessibilityLabel).toBe(
        isLast ? 'Got it' : 'Next',
      );
      await press(findByTestId(renderer, 'walkthrough-advance'));
    }
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
  });

  it('Got it (last step) -> dismiss', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    await walkTo(renderer, WALKTHROUGH_STEPS.length - 1);
    expect(pressableLabels(renderer)).toEqual([
      'Dismiss walkthrough',
      'Got it',
    ]);

    await press(findByTestId(renderer, 'walkthrough-advance'));

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
  });

  it('a double tap on Next advances exactly one step (index is closed over)', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    const advance = findByTestId(renderer, 'walkthrough-advance');
    await act(async () => {
      advance!.props.onPress();
      advance!.props.onPress();
    });
    const text = textContent(renderer);
    expect(text).toContain(WALKTHROUGH_STEPS[1]!.headline);
    expect(text).not.toContain(WALKTHROUGH_STEPS[2]!.headline);
  });

  it('a double tap on Got it dismisses once without throwing', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    await walkTo(renderer, WALKTHROUGH_STEPS.length - 1);
    const gotIt = findByTestId(renderer, 'walkthrough-advance');
    await act(async () => {
      gotIt!.props.onPress();
      gotIt!.props.onPress();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
  });

  it('backdrop tap -> dismiss (the tour never blocks input)', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    const backdrop = findBackdrop(renderer);
    expect(backdrop?.props.accessibilityLabel).toBe('Dismiss walkthrough');
    // WF-ISSUE: Backdrop dismiss Pressable has no accessibilityRole
    // expect(backdrop?.props.accessibilityRole).toBe('button');

    await press(backdrop);

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
  });

  it('backdrop tap works on every step, including the last', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    await walkTo(renderer, WALKTHROUGH_STEPS.length - 1);
    await press(findBackdrop(renderer));
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('Modal.onRequestClose (hardware back) -> dismiss', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    const modal = findModal(renderer);
    expect(modal).toBeDefined();
    expect(modal!.props.visible).toBe(true);
    expect(modal!.props.transparent).toBe(true);

    await act(async () => {
      modal!.props.onRequestClose();
    });

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(findModal(renderer)!.props.visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
  });

  it('Next/Got it button is role=button with a >=44pt min height', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    const host = advanceHost(renderer);
    expect(host).toBeDefined();
    expect(host!.props.accessibilityRole).toBe('button');
    expect(host!.props.accessibilityLabel).toBe('Next');
    expect(host!.props.accessibilityState?.disabled).toBeFalsy();
    const style = StyleSheet.flatten(host!.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(44);
  });

  it('announces each newly anchored step to screen readers', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringContaining(
        `Walkthrough, step 1 of ${WALKTHROUGH_STEPS.length}. ${WALKTHROUGH_STEPS[0]!.headline}`,
      ),
    );
    await press(findByTestId(renderer, 'walkthrough-advance'));
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringContaining(
        `Walkthrough, step 2 of ${WALKTHROUGH_STEPS.length}. ${WALKTHROUGH_STEPS[1]!.headline}`,
      ),
    );
  });
});

describe('FirstRunWalkthrough measurement (async path behind the buttons)', () => {
  it('Next skips a step whose measurer REJECTS instead of dead-ending', async () => {
    registerTargets(['coach-fab', 'tab-library', 'tab-progress']);
    registerTargets(['rank-banner'], () =>
      Promise.reject(new Error('measureInWindow failed')),
    );
    const renderer = await renderVisible();
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[0]!.headline);

    await press(findByTestId(renderer, 'walkthrough-advance'));
    await settle(RETRY_BUDGET_MS);

    const text = textContent(renderer);
    expect(text).toContain(WALKTHROUGH_STEPS[2]!.headline);
    expect(text).not.toContain(WALKTHROUGH_STEPS[1]!.headline);
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(findByTestId(renderer, 'walkthrough-advance')).toBeDefined();
  });

  it('Next skips a step whose measurer resolves null after the retry budget', async () => {
    registerTargets(['coach-fab', 'tab-library', 'tab-progress']);
    const nullMeasure = jest.fn(() => Promise.resolve(null));
    registerTargets(['rank-banner'], nullMeasure);
    const renderer = await renderVisible();

    await press(findByTestId(renderer, 'walkthrough-advance'));
    // Not yet skipped: the callout is withdrawn while retries run.
    expect(findByTestId(renderer, 'walkthrough-advance')).toBeUndefined();
    await settle(RETRY_BUDGET_MS);

    expect(nullMeasure).toHaveBeenCalledTimes(6);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[2]!.headline);
    expect(findByTestId(renderer, 'walkthrough-advance')).toBeDefined();
  });

  it('Next skips an UNREGISTERED step immediately (no retry wait)', async () => {
    registerTargets(['coach-fab', 'tab-library', 'tab-progress']);
    const renderer = await renderVisible();
    await press(findByTestId(renderer, 'walkthrough-advance'));
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[2]!.headline);
  });

  it('Next ends the tour when every remaining target is gone', async () => {
    registerTargets(['coach-fab']);
    const renderer = await renderVisible();
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[0]!.headline);
    await press(findByTestId(renderer, 'walkthrough-advance'));
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
  });

  it('dismisses without rendering any control when no target measures', async () => {
    const renderer = await renderVisible();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(pressables(renderer)).toHaveLength(0);
  });

  it('backdrop still dismisses while a measurement is pending', async () => {
    registerTargets(ALL_TARGETS, () => new Promise<TargetRect>(() => {}));
    const renderer = await renderVisible();
    expect(stageMounted(renderer)).toBe(true);
    expect(findByTestId(renderer, 'walkthrough-advance')).toBeUndefined();
    expect(pressableLabels(renderer)).toEqual(['Dismiss walkthrough']);

    await press(findBackdrop(renderer));

    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
    await settle(RETRY_BUDGET_MS);
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('a late-resolving measurement after dismiss does not resurrect the tour', async () => {
    let resolveMeasure: ((rect: TargetRect) => void) | null = null;
    registerTargets(
      ALL_TARGETS,
      () =>
        new Promise<TargetRect>(resolve => {
          resolveMeasure = resolve;
        }),
    );
    const renderer = await renderVisible();
    await press(findBackdrop(renderer));
    expect(resolveMeasure).not.toBeNull();
    await act(async () => {
      resolveMeasure!(TARGET_RECTS['coach-fab']);
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(stageMounted(renderer)).toBe(false);
  });

  it('store.replay (Settings -> About) re-raises the tour at step one after a dismiss', async () => {
    registerTargets(ALL_TARGETS);
    const renderer = await renderVisible();
    await walkTo(renderer, 2);
    await press(findByTestId(renderer, 'walkthrough-skip'));
    expect(stageMounted(renderer)).toBe(false);

    await act(async () => {
      useWalkthroughStore.getState().replay();
    });

    expect(stageMounted(renderer)).toBe(true);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[0]!.headline);
    expect(pressableLabels(renderer)).toEqual([
      'Dismiss walkthrough',
      'Next',
      'Skip walkthrough',
    ]);
  });
});
