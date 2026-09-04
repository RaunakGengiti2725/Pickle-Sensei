/**
 * ADVERSARIAL PASS 3 — scenario 5 (mobile-design-components-walkthrough).
 *
 * Attack: `useWalkthroughStore.getState().replay()` while the spotlight tour
 * is ALREADY visible and parked on step 3. `replay` is documented (Settings →
 * About → "Replay walkthrough") as re-showing the tour; a replay that leaves
 * the user on step 3 is not a replay. The stage index lives in
 * `WalkthroughStage` local state and the store's `raise()` only flips
 * `visible`, so a same-session replay has nothing to reset — the expectation
 * below (stage returns to step 1) documents the intended contract.
 *
 * Also covered: replay after dismiss (fresh stage), replay/dismiss/replay in
 * one act, and rapid repeated replay() calls.
 */
import React from 'react';
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

let unregister: Array<() => void> = [];

beforeEach(() => {
  for (const key of Object.keys(TARGET_RECTS) as WalkthroughTargetKey[]) {
    unregister.push(
      registerWalkthroughMeasurer(key, () =>
        Promise.resolve(TARGET_RECTS[key]),
      ),
    );
  }
});

afterEach(() => {
  for (const cleanup of unregister) cleanup();
  unregister = [];
  act(() => {
    useWalkthroughStore.setState({ visible: false });
  });
});

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

/** Host (native) Views carrying the stage testID — one per mounted stage. */
function stageHosts(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' && n.props.testID === 'first-run-walkthrough',
  );
}

function stepIndexOnScreen(renderer: TestRenderer.ReactTestRenderer): number {
  const text = textContent(renderer);
  const shown = WALKTHROUGH_STEPS.map((s, i) => [s.headline, i] as const)
    .filter(([headline]) => text.includes(headline))
    .map(([, i]) => i);
  expect(shown.length).toBeLessThanOrEqual(1);
  return shown[0] ?? -1;
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const target = renderer.root.findAll(
    node => node.props.testID === testID && node.props.onPress !== undefined,
  )[0];
  expect(target).toBeDefined();
  await act(async () => target!.props.onPress());
}

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

async function advanceTo(
  renderer: TestRenderer.ReactTestRenderer,
  step: number,
) {
  for (let i = 1; i < step; i += 1)
    await press(renderer, 'walkthrough-advance');
  expect(stepIndexOnScreen(renderer)).toBe(step - 1);
}

describe('walkthrough replay() while already visible', () => {
  it('assigned attack: replay() on step 3 returns the tour to step 1', async () => {
    const renderer = await renderVisible();
    await advanceTo(renderer, 3);
    expect(textContent(renderer)).toContain('Your reads live here.');

    await act(async () => {
      useWalkthroughStore.getState().replay();
    });

    expect(useWalkthroughStore.getState().visible).toBe(true);
    // A replay must start from the beginning — the user asked to see the tour.
    expect(stepIndexOnScreen(renderer)).toBe(0);
    expect(textContent(renderer)).toContain(WALKTHROUGH_STEPS[0]!.headline);
    act(() => renderer.unmount());
  });

  it('replay() on step 3 keeps the tour visible and never dismisses or skips (no crash, no blank overlay)', async () => {
    const renderer = await renderVisible();
    await advanceTo(renderer, 3);
    await act(async () => {
      useWalkthroughStore.getState().replay();
    });
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(stageHosts(renderer)).toHaveLength(1);
    expect(stepIndexOnScreen(renderer)).toBeGreaterThanOrEqual(0);
    act(() => renderer.unmount());
  });

  it('dismiss() then replay() mounts a fresh stage on step 1', async () => {
    const renderer = await renderVisible();
    await advanceTo(renderer, 3);
    await act(async () => {
      useWalkthroughStore.getState().dismiss();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
    await act(async () => {
      useWalkthroughStore.getState().replay();
    });
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(stepIndexOnScreen(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('replay(); dismiss(); replay() inside one act ends visible on step 1', async () => {
    const renderer = await renderVisible();
    await advanceTo(renderer, 3);
    await act(async () => {
      const s = useWalkthroughStore.getState();
      s.replay();
      s.dismiss();
      s.replay();
    });
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(stepIndexOnScreen(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('1,000 rapid replay() calls while visible leave exactly one stage mounted', async () => {
    const renderer = await renderVisible();
    await act(async () => {
      for (let i = 0; i < 1_000; i += 1)
        useWalkthroughStore.getState().replay();
    });
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(stageHosts(renderer)).toHaveLength(1);
    expect(stepIndexOnScreen(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('replay() never re-arms the first-run auto-show (queued stays false; maybeShowFirstRun no-ops for the session)', async () => {
    const renderer = await renderVisible();
    await act(async () => {
      useWalkthroughStore.getState().replay();
    });
    expect(useWalkthroughStore.getState().queued).toBe(false);
    await act(async () => {
      useWalkthroughStore.getState().dismiss();
    });
    await act(async () => {
      await useWalkthroughStore.getState().maybeShowFirstRun();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });
});
