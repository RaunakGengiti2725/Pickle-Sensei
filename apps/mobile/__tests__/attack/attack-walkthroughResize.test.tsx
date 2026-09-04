/**
 * ADVERSARIAL PASS 3 — scenario 6 (mobile-design-components-walkthrough).
 *
 * Attack: change the window size (what `useWindowDimensions` reports) while
 * the spotlight tour is mid-step. Expected: the measurement effect restarts
 * for the SAME step, the stale rect is cleared while the new measurement is
 * in flight, the step is NOT skipped when the target is still on screen in
 * the new window, and a measurement that was in flight for the OLD window is
 * discarded (never applied to the new one). Shrinking the window so the
 * target's centre leaves it must skip the step only after the retry budget.
 *
 * Window changes are driven through the real `Dimensions.set` so the actual
 * `useWindowDimensions` subscription re-renders the stage, exactly as a
 * rotation / Stage Manager resize would.
 */
import React from 'react';
import { AccessibilityInfo, Dimensions } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

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

const TARGET_RECTS: Record<WalkthroughTargetKey, TargetRect> = {
  'coach-fab': { x: 165, y: 700, width: 64, height: 64 },
  'rank-banner': { x: 24, y: 120, width: 345, height: 96 },
  'tab-library': { x: 96, y: 760, width: 70, height: 54 },
  'tab-progress': { x: 236, y: 760, width: 70, height: 54 },
};
const ALL_TARGETS = Object.keys(TARGET_RECTS) as WalkthroughTargetKey[];

/** Registered-target retries: 6 attempts × 120ms sleep (component constant). */
const RETRY_BUDGET_MS = 6 * 120 + 50;

const PORTRAIT = { width: 393, height: 852, scale: 3, fontScale: 1 };
const LARGE = { width: 430, height: 932, scale: 3, fontScale: 1 };
const TINY = { width: 200, height: 300, scale: 3, fontScale: 1 };

function setWindow(dims: typeof PORTRAIT) {
  act(() => {
    Dimensions.set({ window: dims, screen: dims });
  });
}

let unregister: Array<() => void> = [];
const measureCalls: Record<string, number> = {};
type Deferred = {
  promise: Promise<TargetRect | null>;
  resolve: (r: TargetRect | null) => void;
};
let pendingMeasures: Deferred[] = [];

function deferred(): Deferred {
  let resolve!: (r: TargetRect | null) => void;
  const promise = new Promise<TargetRect | null>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Immediate measurers for every target except `manual`, whose measurements
 * are parked in `pendingMeasures` and resolved by the test. */
function registerTargets(manual?: WalkthroughTargetKey) {
  for (const key of ALL_TARGETS) {
    measureCalls[key] = 0;
    unregister.push(
      registerWalkthroughMeasurer(key, () => {
        measureCalls[key] = (measureCalls[key] ?? 0) + 1;
        if (key === manual) {
          const d = deferred();
          pendingMeasures.push(d);
          return d.promise;
        }
        return Promise.resolve(TARGET_RECTS[key]);
      }),
    );
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  setWindow(PORTRAIT);
  pendingMeasures = [];
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

/** One retry budget per step: React only commits the `setIndex` from an
 * exhausted step when the surrounding act() resolves, so each skipped step
 * needs its own act. */
async function settleEveryStep() {
  for (let i = 0; i < WALKTHROUGH_STEPS.length; i += 1) {
    await settle(RETRY_BUDGET_MS);
  }
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function stepIndexOnScreen(renderer: TestRenderer.ReactTestRenderer): number {
  const text = textContent(renderer);
  const shown = WALKTHROUGH_STEPS.map((s, i) => [s.headline, i] as const)
    .filter(([headline]) => text.includes(headline))
    .map(([, i]) => i);
  expect(shown.length).toBeLessThanOrEqual(1);
  return shown[0] ?? -1;
}

/** The rect the spotlight is currently drawn from (null while measuring). */
function spotlightRect(
  renderer: TestRenderer.ReactTestRenderer,
): TargetRect | null {
  const node = renderer.root.findAll(
    n => typeof n.type !== 'string' && n.props.rect !== undefined,
  )[0];
  return node ? (node.props.rect as TargetRect) : null;
}

describe('walkthrough window resize mid-step', () => {
  it('assigned attack: a window change re-measures the same step, clears the rect meanwhile, and does not skip it', async () => {
    registerTargets('coach-fab');
    const renderer = await renderVisible();
    expect(measureCalls['coach-fab']).toBe(1);
    await act(async () => {
      pendingMeasures.shift()!.resolve(TARGET_RECTS['coach-fab']);
    });
    expect(stepIndexOnScreen(renderer)).toBe(0);
    expect(spotlightRect(renderer)).toEqual(TARGET_RECTS['coach-fab']);

    setWindow(LARGE);

    // Measurement restarted for the SAME step; the old rect is gone while
    // the new one is in flight — no spotlight drawn at stale coordinates.
    expect(measureCalls['coach-fab']).toBe(2);
    expect(spotlightRect(renderer)).toBeNull();
    expect(stepIndexOnScreen(renderer)).toBe(-1);
    expect(useWalkthroughStore.getState().visible).toBe(true);

    const moved = { x: 183, y: 780, width: 64, height: 64 };
    await act(async () => {
      pendingMeasures.shift()!.resolve(moved);
    });
    expect(stepIndexOnScreen(renderer)).toBe(0);
    expect(spotlightRect(renderer)).toEqual(moved);
    expect(measureCalls['rank-banner']).toBe(0);
    act(() => renderer.unmount());
  });

  it('a measurement in flight for the OLD window is discarded when the window changes', async () => {
    registerTargets('coach-fab');
    const renderer = await renderVisible();
    const stale = pendingMeasures.shift()!;
    expect(measureCalls['coach-fab']).toBe(1);

    setWindow(LARGE);
    expect(measureCalls['coach-fab']).toBe(2);
    const fresh = pendingMeasures.shift()!;

    // The stale (portrait) measurement lands AFTER the resize: it must be ignored.
    const staleRect = { x: 1, y: 1, width: 10, height: 10 };
    await act(async () => {
      stale.resolve(staleRect);
    });
    expect(spotlightRect(renderer)).toBeNull();

    const freshRect = { x: 183, y: 780, width: 64, height: 64 };
    await act(async () => {
      fresh.resolve(freshRect);
    });
    expect(spotlightRect(renderer)).toEqual(freshRect);
    expect(stepIndexOnScreen(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('two rapid window changes only ever apply the LAST measurement', async () => {
    registerTargets('coach-fab');
    const renderer = await renderVisible();
    const first = pendingMeasures.shift()!;
    setWindow(LARGE);
    const second = pendingMeasures.shift()!;
    setWindow({ ...LARGE, height: 900 });
    const third = pendingMeasures.shift()!;
    expect(measureCalls['coach-fab']).toBe(3);

    await act(async () => {
      third.resolve({ x: 3, y: 700, width: 64, height: 64 });
      second.resolve({ x: 2, y: 700, width: 64, height: 64 });
      first.resolve({ x: 1, y: 700, width: 64, height: 64 });
    });
    expect(spotlightRect(renderer)?.x).toBe(3);
    expect(stepIndexOnScreen(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('a resize on step 3 keeps the user on step 3 (index survives the re-measure)', async () => {
    registerTargets();
    const renderer = await renderVisible();
    for (let i = 0; i < 2; i += 1) {
      const next = renderer.root.findAll(
        n => n.props.testID === 'walkthrough-advance' && n.props.onPress,
      )[0]!;
      await act(async () => next.props.onPress());
    }
    expect(stepIndexOnScreen(renderer)).toBe(2);
    const before = measureCalls['tab-library'];

    setWindow(LARGE);
    await settle(0);

    expect(measureCalls['tab-library']).toBe(before! + 1);
    expect(stepIndexOnScreen(renderer)).toBe(2);
    expect(spotlightRect(renderer)).toEqual(TARGET_RECTS['tab-library']);
    act(() => renderer.unmount());
  });

  it('shrinking the window until the target centre leaves it skips the step only after the retry budget', async () => {
    registerTargets();
    const renderer = await renderVisible();
    expect(stepIndexOnScreen(renderer)).toBe(0);

    setWindow(TINY); // coach-fab centre (197, 732) is outside 200×300
    await settle(0);
    expect(stepIndexOnScreen(renderer)).toBe(-1);
    expect(useWalkthroughStore.getState().visible).toBe(true);

    await settle(RETRY_BUDGET_MS);
    // rank-banner centre (196, 168) IS inside 200×300 → tour lands on step 2.
    expect(stepIndexOnScreen(renderer)).toBe(1);
    expect(measureCalls['coach-fab']).toBe(1 + 6);
    act(() => renderer.unmount());
  });

  it('a resize that brings a skipped-off-screen target back never resurrects an already-passed step', async () => {
    registerTargets();
    const renderer = await renderVisible();
    setWindow(TINY);
    await settle(RETRY_BUDGET_MS);
    expect(stepIndexOnScreen(renderer)).toBe(1);

    setWindow(PORTRAIT);
    await settle(0);
    // The tour must not jump back to step 1 just because the window grew.
    expect(stepIndexOnScreen(renderer)).toBe(1);
    act(() => renderer.unmount());
  });

  it('a resize while a rect is shown re-announces the SAME step to VoiceOver at most once', async () => {
    registerTargets();
    // RN's jest setup already installs a jest.fn here; spyOn hands back that
    // shared mock, so its call log must be cleared before counting.
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {});
    announce.mockClear();
    const renderer = await renderVisible();
    expect(announce).toHaveBeenCalledTimes(1);
    setWindow(LARGE);
    await settle(0);
    // Re-measuring the same step for a new window is not a new step: the
    // announcement count for step 1 must stay bounded (≤ 2 — once per rect).
    expect(announce.mock.calls.length).toBeLessThanOrEqual(2);
    for (const [message] of announce.mock.calls) {
      expect(String(message)).toContain('step 1 of');
    }
    act(() => renderer.unmount());
  });

  it('zero / NaN window dimensions do not crash the stage or leak NaN into the spotlight', async () => {
    registerTargets();
    const renderer = await renderVisible();
    setWindow({ width: 0, height: 0, scale: 3, fontScale: 1 });
    await settleEveryStep();
    // No target can be centred in a 0×0 window → every step skipped → tour
    // dismissed, never pointing at nothing.
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());

    act(() => {
      useWalkthroughStore.setState({ visible: true });
    });
    const renderer2 = await renderVisible();
    setWindow({
      width: Number.NaN,
      height: Number.NaN,
      scale: 3,
      fontScale: 1,
    });
    await settleEveryStep();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer2.unmount());
  });
});
