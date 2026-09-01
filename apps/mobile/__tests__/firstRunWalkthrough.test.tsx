import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// The walkthrough store persists through SQLite; the native module is absent
// under jest and these tests drive store state directly.
jest.mock('../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
  arrowGeometry,
} from '../src/walkthrough/FirstRunWalkthrough';
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

const TARGET_RECTS: Record<WalkthroughTargetKey, { x: number; y: number; width: number; height: number }> = {
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

afterEach(() => {
  for (const cleanup of unregister) cleanup();
  unregister = [];
  useWalkthroughStore.setState({ visible: false });
});

async function renderVisible() {
  useWalkthroughStore.setState({ visible: true });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FirstRunWalkthrough />);
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
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    expect(
      renderer.root.findAll(n => n.props.testID === 'first-run-walkthrough'),
    ).toHaveLength(0);
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
