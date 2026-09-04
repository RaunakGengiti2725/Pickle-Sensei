/**
 * AUDIT — walkthrough (src/walkthrough/*): untested edges.
 *  - replay() while visible does not reset the stage index (store:97-104)
 *  - registerWalkthroughMeasurer is last-writer-wins (targets.ts)
 *  - 6×120 ms measurement budget skips a target that measures late
 *  - Skip control hit target
 *  - rectVisibleInWindow partial-visibility edge
 */
import React from 'react';
import { StyleSheet, Text, type ViewStyle } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
  rectVisibleInWindow,
} from '../../src/walkthrough/FirstRunWalkthrough';
import {
  hasWalkthroughTarget,
  measureWalkthroughTarget,
  registerWalkthroughMeasurer,
  type TargetRect,
} from '../../src/walkthrough/targets';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

const VISIBLE_RECT: TargetRect = {
  x: 20,
  y: 120,
  width: 200,
  height: 60,
};

const mounted: ReactTestRenderer[] = [];

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

function flat(node: ReactTestInstance): ViewStyle {
  return (StyleSheet.flatten(node.props.style) ?? {}) as ViewStyle;
}

function hostByTestID(
  renderer: ReactTestRenderer,
  testID: string,
): ReactTestInstance {
  return renderer.root.find(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
}

function click(host: ReactTestInstance) {
  act(() => {
    host.props.onClick({
      currentTarget: host,
      target: host,
      nativeEvent: {},
      stopPropagation: () => {},
    });
  });
}

function texts(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => React.Children.toArray(node.props.children))
    .filter((child): child is string => typeof child === 'string');
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

let unregister: Array<() => void> = [];

beforeEach(() => {
  act(() => {
    useWalkthroughStore.setState({ visible: false, queued: false });
  });
  unregister = WALKTHROUGH_STEPS.map(step =>
    registerWalkthroughMeasurer(step.targetKey, async () => VISIBLE_RECT),
  );
});

afterEach(() => {
  // Unmount even when an assertion threw, so a leaked stage cannot keep
  // measuring against the next test's registrants.
  while (mounted.length) {
    const renderer = mounted.pop()!;
    act(() => renderer.unmount());
  }
  unregister.forEach(fn => fn());
  unregister = [];
  jest.useRealTimers();
});

describe('registerWalkthroughMeasurer', () => {
  it('VERIFIED: a second registrant for the same key replaces the first; unregistering the stale one is a no-op', async () => {
    unregister.forEach(fn => fn());
    unregister = [];
    const key = WALKTHROUGH_STEPS[0]!.targetKey;
    const a: TargetRect = { x: 1, y: 1, width: 10, height: 10 };
    const b: TargetRect = { x: 2, y: 2, width: 20, height: 20 };
    const offA = registerWalkthroughMeasurer(key, async () => a);
    const offB = registerWalkthroughMeasurer(key, async () => b);
    expect(hasWalkthroughTarget(key)).toBe(true);
    await expect(measureWalkthroughTarget(key)).resolves.toEqual(b);
    offA();
    expect(hasWalkthroughTarget(key)).toBe(true);
    await expect(measureWalkthroughTarget(key)).resolves.toEqual(b);
    offB();
    expect(hasWalkthroughTarget(key)).toBe(false);
    await expect(measureWalkthroughTarget(key)).resolves.toBeNull();
  });

  it('VERIFIED: a throwing measurer resolves null rather than rejecting', async () => {
    unregister.forEach(fn => fn());
    unregister = [];
    const key = WALKTHROUGH_STEPS[0]!.targetKey;
    const off = registerWalkthroughMeasurer(key, async () => {
      throw new Error('layout not ready');
    });
    await expect(measureWalkthroughTarget(key)).resolves.toBeNull();
    off();
  });
});

describe('rectVisibleInWindow', () => {
  it('VERIFIED: the rule is centre-in-window — a rect whose centre is inside counts even when its edges are clipped', () => {
    expect(rectVisibleInWindow(VISIBLE_RECT, 390, 844)).toBe(true);
    expect(
      rectVisibleInWindow({ x: 0, y: 0, width: 390, height: 844 }, 390, 844),
    ).toBe(true);
    // centre x = 350 (inside), right edge 400 (clipped) → visible
    expect(
      rectVisibleInWindow({ x: 300, y: 100, width: 100, height: 40 }, 390, 844),
    ).toBe(true);
    // centre y = 850 → off-window
    expect(
      rectVisibleInWindow({ x: 10, y: 830, width: 40, height: 40 }, 390, 844),
    ).toBe(false);
    // centre x = -21 → off-window
    expect(
      rectVisibleInWindow({ x: -41, y: 10, width: 40, height: 40 }, 390, 844),
    ).toBe(false);
    // centre exactly on the edge counts as inside
    expect(
      rectVisibleInWindow({ x: 370, y: 10, width: 40, height: 40 }, 390, 844),
    ).toBe(true);
    // zero-sized rect at a valid point is still "visible" by this rule
    expect(
      rectVisibleInWindow({ x: 10, y: 10, width: 0, height: 0 }, 390, 844),
    ).toBe(true);
  });
});

describe('FirstRunWalkthrough', () => {
  it('VERIFIED: Skip is a labelled button whose hitSlop grows the text row to ≥44pt', async () => {
    act(() => {
      useWalkthroughStore.getState().replay();
    });
    const renderer = render(<FirstRunWalkthrough />);
    await settle();
    const skip = hostByTestID(renderer, 'walkthrough-skip');
    expect(skip.props.accessibilityRole).toBe('button');
    expect(skip.props.accessibilityLabel).toBe('Skip walkthrough');
    const style = flat(skip);
    const slop = skip.props.hitSlop;
    const vertical =
      typeof slop === 'number'
        ? slop * 2
        : (slop?.top ?? 0) + (slop?.bottom ?? 0);
    const paddingV =
      (typeof style.paddingVertical === 'number' ? style.paddingVertical : 0) *
      2;
    // bodyBold line height is 22 — the visible row is padding + one line.
    const lineHeight = 22;
    expect(paddingV + lineHeight + vertical).toBeGreaterThanOrEqual(44);
    click(skip);
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('VERIFIED (documented contract): replay() while visible is a no-op on the stage; dismiss → replay restarts from step 1', async () => {
    // walkthroughStore.ts:97-104 — raise() only flips `visible`; the index
    // lives in WalkthroughStage. The tour is a full-screen Modal, so the
    // only replay affordance (Settings row) is unreachable while it shows;
    // the reachable path is dismiss → replay, which remounts the stage.
    act(() => {
      useWalkthroughStore.getState().replay();
    });
    const renderer = render(<FirstRunWalkthrough />);
    await settle();
    expect(texts(renderer)).toContain(WALKTHROUGH_STEPS[0]!.headline);
    click(hostByTestID(renderer, 'walkthrough-advance'));
    await settle();
    expect(texts(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);

    act(() => {
      useWalkthroughStore.getState().replay();
    });
    await settle();
    expect(texts(renderer)).toContain(WALKTHROUGH_STEPS[1]!.headline);
    expect(texts(renderer)).not.toContain(WALKTHROUGH_STEPS[0]!.headline);

    act(() => {
      useWalkthroughStore.getState().dismiss();
    });
    await settle();
    expect(
      renderer.root.findAllByProps({ testID: 'first-run-walkthrough' }),
    ).toHaveLength(0);
    act(() => {
      useWalkthroughStore.getState().replay();
    });
    await settle();
    expect(texts(renderer)).toContain(WALKTHROUGH_STEPS[0]!.headline);
  });

  it('VERIFIED (documented budget): a registered target gets exactly 6 measurements over ~720 ms, then the step is skipped', async () => {
    // FirstRunWalkthrough.tsx:347-368 — by design a step that never
    // measures is skipped rather than pointing at empty space. This pins the
    // exact budget so a layout slower than ~720 ms is a known skip, not a
    // surprise. A target that measures on its 6th attempt is still shown.
    jest.useFakeTimers();
    unregister.forEach(fn => fn());
    let calls = 0;
    let succeedOn = 7;
    unregister = WALKTHROUGH_STEPS.map((step, i) =>
      registerWalkthroughMeasurer(step.targetKey, async () => {
        if (i !== 0) return VISIBLE_RECT;
        calls += 1;
        return calls >= succeedOn ? VISIBLE_RECT : null;
      }),
    );
    const drive = async (renderer: ReactTestRenderer) => {
      for (let tick = 0; tick < 12; tick++) {
        await settle();
        act(() => {
          jest.advanceTimersByTime(120);
        });
        await settle();
      }
      return texts(renderer);
    };

    act(() => {
      useWalkthroughStore.getState().replay();
    });
    const first = render(<FirstRunWalkthrough />);
    const late = await drive(first);
    expect(calls).toBe(6);
    expect(late).not.toContain(WALKTHROUGH_STEPS[0]!.headline);
    expect(late).toContain(WALKTHROUGH_STEPS[1]!.headline);

    act(() => {
      useWalkthroughStore.getState().dismiss();
    });
    act(() => mounted.splice(mounted.indexOf(first), 1)[0]!.unmount());
    calls = 0;
    succeedOn = 6;
    act(() => {
      useWalkthroughStore.getState().replay();
    });
    const inBudget = await drive(render(<FirstRunWalkthrough />));
    expect(calls).toBe(6);
    expect(inBudget).toContain(WALKTHROUGH_STEPS[0]!.headline);
    expect(inBudget).not.toContain(WALKTHROUGH_STEPS[1]!.headline);
  });

  it('VERIFIED: hardware back (onRequestClose) dismisses and marks not visible', async () => {
    act(() => {
      useWalkthroughStore.getState().replay();
    });
    const renderer = render(<FirstRunWalkthrough />);
    await settle();
    const modal = renderer.root.find(
      node => typeof node.type !== 'string' && node.props.onRequestClose,
    );
    act(() => {
      modal.props.onRequestClose();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });
});
