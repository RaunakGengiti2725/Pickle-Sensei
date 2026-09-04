/**
 * Structural audit #2 probes for the first-run walkthrough: target registry
 * ownership, overlay arbitration with several ceremonies, the measurement
 * retry budget, and the Skip control's touch target.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { FirstRunWalkthrough } from '../../src/walkthrough/FirstRunWalkthrough';
import {
  hasWalkthroughTarget,
  measureWalkthroughTarget,
  registerWalkthroughMeasurer,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import {
  useWalkthroughStore,
  walkthroughYieldsTo,
} from '../../src/walkthrough/walkthroughStore';
import { type as typeTokens } from '../../src/design/tokens';

const RECTS: Record<
  WalkthroughTargetKey,
  { x: number; y: number; width: number; height: number }
> = {
  'coach-fab': { x: 165, y: 700, width: 64, height: 64 },
  'rank-banner': { x: 24, y: 120, width: 345, height: 96 },
  'tab-library': { x: 96, y: 760, width: 70, height: 54 },
  'tab-progress': { x: 236, y: 760, width: 70, height: 54 },
};

let cleanups: Array<() => void> = [];
const roots: TestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  useWalkthroughStore.setState({ visible: false, queued: false });
});

function registerAll(except: WalkthroughTargetKey[] = []) {
  for (const key of Object.keys(RECTS) as WalkthroughTargetKey[]) {
    if (except.includes(key)) continue;
    cleanups.push(
      registerWalkthroughMeasurer(key, () => Promise.resolve(RECTS[key])),
    );
  }
}

async function renderVisible() {
  useWalkthroughStore.setState({ visible: true });
  let root!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    root = TestRenderer.create(<FirstRunWalkthrough />);
  });
  roots.push(root);
  return root;
}

function textContent(root: TestRenderer.ReactTestRenderer): string {
  return root.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

describe('walkthrough target registry ownership', () => {
  it('keeps the still-mounted registrant when a later registrant for the same key unregisters', async () => {
    const first = () => Promise.resolve(RECTS['rank-banner']);
    const second = () => Promise.resolve({ x: 0, y: 0, width: 10, height: 10 });
    const unregisterFirst = registerWalkthroughMeasurer('rank-banner', first);
    const unregisterSecond = registerWalkthroughMeasurer('rank-banner', second);
    cleanups.push(unregisterFirst);

    unregisterSecond();

    // The first owner is still mounted; the tour must still be able to point
    // at it.
    expect(hasWalkthroughTarget('rank-banner')).toBe(true);
    await expect(measureWalkthroughTarget('rank-banner')).resolves.toEqual(
      RECTS['rank-banner'],
    );
  });

  it('a remount replaces its stale predecessor and its own cleanup is exact (verified invariant)', async () => {
    const stale = () => Promise.resolve({ x: 1, y: 1, width: 1, height: 1 });
    const fresh = () => Promise.resolve(RECTS['coach-fab']);
    const unregisterStale = registerWalkthroughMeasurer('coach-fab', stale);
    unregisterStale();
    const unregisterFresh = registerWalkthroughMeasurer('coach-fab', fresh);
    cleanups.push(unregisterFresh);
    unregisterStale(); // late duplicate cleanup must not evict the fresh owner
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toEqual(
      RECTS['coach-fab'],
    );
  });

  it('a throwing measurer yields null rather than taking the tour down (verified invariant)', async () => {
    cleanups.push(
      registerWalkthroughMeasurer('tab-library', () =>
        Promise.reject(new Error('measure failed')),
      ),
    );
    await expect(measureWalkthroughTarget('tab-library')).resolves.toBeNull();
  });
});

describe('overlay arbitration with several ceremonies (verified invariant)', () => {
  it('raises the queued tour only after every showing ceremony is dismissed', () => {
    let aShowing = true;
    let bShowing = true;
    const aListeners = new Set<() => void>();
    const bListeners = new Set<() => void>();
    cleanups.push(
      walkthroughYieldsTo({
        isShowing: () => aShowing,
        subscribe: listener => {
          aListeners.add(listener);
          return () => aListeners.delete(listener);
        },
      }),
      walkthroughYieldsTo({
        isShowing: () => bShowing,
        subscribe: listener => {
          bListeners.add(listener);
          return () => bListeners.delete(listener);
        },
      }),
    );

    useWalkthroughStore.getState().replay();
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: false,
      queued: true,
    });

    aShowing = false;
    aListeners.forEach(listener => listener());
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: false,
      queued: true,
    });

    bShowing = false;
    bListeners.forEach(listener => listener());
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: true,
      queued: false,
    });
  });
});

describe('measurement retry budget (documented behaviour)', () => {
  it('anchors a registered target that measures on a retry within the budget', async () => {
    let calls = 0;
    cleanups.push(
      registerWalkthroughMeasurer('coach-fab', () => {
        calls += 1;
        return Promise.resolve(calls < 3 ? null : RECTS['coach-fab']);
      }),
    );
    registerAll(['coach-fab']);
    const root = await renderVisible();
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 400));
    });
    expect(textContent(root)).toContain('Every read starts here.');
    expect(calls).toBe(3);
  });

  it('skips a registered target that never measures within six attempts', async () => {
    let calls = 0;
    cleanups.push(
      registerWalkthroughMeasurer('coach-fab', () => {
        calls += 1;
        return Promise.resolve(null);
      }),
    );
    registerAll(['coach-fab']);
    const root = await renderVisible();
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 950));
    });
    const text = textContent(root);
    expect(text).not.toContain('Every read starts here.');
    expect(text).toContain('Only clear reads count.');
    expect(calls).toBe(6);
  });
});

describe('Skip control touch target (verified invariant)', () => {
  it('reaches 44pt in height through padding + hitSlop', async () => {
    registerAll();
    const root = await renderVisible();
    const skip = root.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.testID === 'walkthrough-skip',
    );
    const style = StyleSheet.flatten(skip.props.style) ?? {};
    const paddingVertical = Number(style.paddingVertical ?? 0);
    const hitSlop =
      typeof skip.props.hitSlop === 'number'
        ? skip.props.hitSlop
        : Number(skip.props.hitSlop?.top ?? 0);
    const lineHeight = typeTokens.bodyBold.lineHeight;
    expect(
      lineHeight + paddingVertical * 2 + hitSlop * 2,
    ).toBeGreaterThanOrEqual(44);
    expect(skip.props.accessibilityRole).toBe('button');
    expect(skip.props.accessibilityLabel).toBe('Skip walkthrough');
  });
});
