import React, { useEffect, type MutableRefObject } from 'react';
import { View, type HostInstance } from 'react-native';
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
  useWalkthroughTarget,
  type TargetRect,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

/**
 * Attack pass 3 / scenario 4 — walkthrough target registry under two live
 * owners of the same key ('coach-fab' from two mounted tab bars / Home
 * screens): last-writer-wins on register, identity-checked unregister, and
 * the tour must spotlight the SURVIVING measurer's rect.
 */

const FIRST: TargetRect = { x: 10, y: 10, width: 40, height: 40 };
const SECOND: TargetRect = { x: 165, y: 700, width: 64, height: 64 };
const HOLE_PADDING = 8;

/** Mirrors holeForTarget('circle') so the scrim path can be asserted. */
function circleHoleStart(rect: TargetRect): string {
  const side = Math.max(rect.width, rect.height) + HOLE_PADDING * 2 - 2;
  const x = rect.x + rect.width / 2 - side / 2;
  const y = rect.y + rect.height / 2 - side / 2;
  const r = side / 2;
  return `M ${x + r} ${y}`;
}

let cleanups: Array<() => void> = [];
function register(key: WalkthroughTargetKey, rect: TargetRect | null) {
  const measure = jest.fn(() => Promise.resolve(rect));
  const cleanup = registerWalkthroughMeasurer(key, measure);
  cleanups.push(cleanup);
  return { measure, cleanup };
}

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
  useWalkthroughStore.setState({ visible: false });
  jest.useRealTimers();
});

function scrimPaths(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.props.d === 'string')
    .map(node => node.props.d as string);
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(node => String(node.type) === 'Text')
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

/** The RN jest preset stubs `measureInWindow` as a never-calling-back
 * jest.fn(), so hook tests point the target ref at a hand-made node. */
function fakeNode(reply: () => [number, number, number, number]): HostInstance {
  return {
    measureInWindow: (
      cb: (x: number, y: number, w: number, h: number) => void,
    ) => cb(...reply()),
  } as unknown as HostInstance;
}

function TargetOwner(props: {
  targetKey: WalkthroughTargetKey;
  node: HostInstance;
  testID?: string;
}) {
  const ref = useWalkthroughTarget(props.targetKey);
  useEffect(() => {
    (ref as MutableRefObject<HostInstance | null>).current = props.node;
  }, [props.node, ref]);
  return <View testID={props.testID} />;
}

async function renderVisible() {
  useWalkthroughStore.setState({ visible: true });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<FirstRunWalkthrough />);
  });
  return renderer;
}

describe('walkthrough target registry — two measurers for coach-fab (attack 3)', () => {
  it('unregistering the FIRST leaves the second in place and measurement uses it', async () => {
    const first = register('coach-fab', FIRST);
    const second = register('coach-fab', SECOND);
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);

    first.cleanup();
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toEqual(
      SECOND,
    );
    expect(first.measure).not.toHaveBeenCalled();
    expect(second.measure).toHaveBeenCalledTimes(1);

    // Unregistering the first AGAIN (double cleanup) is a no-op.
    first.cleanup();
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);

    // Unregistering the second empties the slot.
    second.cleanup();
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toBeNull();
  });

  it('unregistering the SECOND (last writer) does not resurrect the first', async () => {
    const first = register('coach-fab', FIRST);
    const second = register('coach-fab', SECOND);
    second.cleanup();
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toBeNull();
    expect(first.measure).not.toHaveBeenCalled();
  });

  it('the tour anchors its spotlight to the SECOND measurer after the first unregisters', async () => {
    const first = register('coach-fab', FIRST);
    register('coach-fab', SECOND);
    register('rank-banner', { x: 24, y: 120, width: 345, height: 96 });
    register('tab-library', { x: 96, y: 760, width: 70, height: 54 });
    register('tab-progress', { x: 236, y: 760, width: 70, height: 54 });
    first.cleanup();

    const renderer = await renderVisible();
    expect(textContent(renderer)).toContain('Every read starts here.');
    const paths = scrimPaths(renderer);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some(d => d.includes(circleHoleStart(SECOND)))).toBe(true);
    expect(paths.some(d => d.includes(circleHoleStart(FIRST)))).toBe(false);
    expect(first.measure).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('two mounted useWalkthroughTarget owners: unmounting the first keeps the tour on the survivor', async () => {
    const nodeA = fakeNode(() => [FIRST.x, FIRST.y, FIRST.width, FIRST.height]);
    const nodeB = fakeNode(() => [
      SECOND.x,
      SECOND.y,
      SECOND.width,
      SECOND.height,
    ]);
    let showB = true;
    let showA = true;
    function Host() {
      return (
        <>
          {showA ? (
            <TargetOwner targetKey="coach-fab" node={nodeA} testID="A" />
          ) : null}
          {showB ? (
            <TargetOwner targetKey="coach-fab" node={nodeB} testID="B" />
          ) : null}
        </>
      );
    }
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Host />);
    });
    // B mounted last → B wins.
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toEqual(
      SECOND,
    );
    // Unmount A (first owner) — B must survive its identity-checked cleanup.
    showA = false;
    await act(async () => renderer.update(<Host />));
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toEqual(
      SECOND,
    );
    // Unmount B → slot empty; measuring is null (step skipped), not a throw.
    showB = false;
    await act(async () => renderer.update(<Host />));
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toBeNull();
    act(() => renderer.unmount());
  });

  it('the hook rejects non-finite / zero-size measurements as null', async () => {
    let reply: [number, number, number, number] = [0, 0, 0, 0];
    const node = fakeNode(() => reply);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TargetOwner targetKey="coach-fab" node={node} />,
      );
    });
    for (const bad of [
      [0, 0, 0, 0],
      [NaN, 1, 2, 3],
      [1, Infinity, 2, 3],
      [1, 2, -5, 3],
      [1, 2, 3, 0],
    ] as Array<[number, number, number, number]>) {
      reply = bad;
      await expect(measureWalkthroughTarget('coach-fab')).resolves.toBeNull();
    }
    reply = [1, 2, 3, 4];
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toEqual({
      x: 1,
      y: 2,
      width: 3,
      height: 4,
    });
    act(() => renderer.unmount());
  });

  it('a measurer that throws or rejects yields null and never takes the tour down', async () => {
    cleanups.push(
      registerWalkthroughMeasurer('coach-fab', () => {
        throw new Error('detached view');
      }),
    );
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toBeNull();
    cleanups.push(
      registerWalkthroughMeasurer('coach-fab', () =>
        Promise.reject(new Error('async boom')),
      ),
    );
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toBeNull();
  });

  it('re-registering the same measurer function twice then cleaning once empties the slot (identity, not count)', () => {
    const measure = () => Promise.resolve(FIRST);
    const c1 = registerWalkthroughMeasurer('coach-fab', measure);
    const c2 = registerWalkthroughMeasurer('coach-fab', measure);
    cleanups.push(c1, c2);
    c1();
    // Same identity → the first cleanup already removed it.
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
    c2();
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
  });

  it('interleaved register/unregister storm (seeded) always ends with the last live writer', async () => {
    // Deterministic LCG so the run is reproducible: seed 20260904.
    let s = 20260904;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
    type Live = { rect: TargetRect; cleanup: () => void; order: number };
    let live: Live[] = [];
    let order = 0;
    for (let i = 0; i < 500; i += 1) {
      if (live.length === 0 || rand() < 0.6) {
        const rect = { x: i, y: i, width: 1 + i, height: 1 + i };
        const cleanup = registerWalkthroughMeasurer('coach-fab', () =>
          Promise.resolve(rect),
        );
        live.push({ rect, cleanup, order: order++ });
      } else {
        const victim = Math.floor(rand() * live.length);
        live[victim]!.cleanup();
        live.splice(victim, 1);
      }
      // Model: the registered measurer is the most recently REGISTERED
      // among the live ones, and only if the latest writer of all is still
      // live; once the latest writer unregisters, the slot is empty even if
      // older owners still exist (they cannot be resurrected).
      const latest = live.reduce<Live | null>(
        (best, cur) => (best === null || cur.order > best.order ? cur : best),
        null,
      );
      const latestOverall = order - 1;
      const expected =
        latest && latest.order === latestOverall ? latest.rect : null;
      const measured = await measureWalkthroughTarget('coach-fab');
      expect(measured).toEqual(expected);
    }
    for (const l of live) l.cleanup();
    live = [];
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
  });

  it('a measurer that never resolves leaves the tour with no callout but the backdrop still dismisses (recoverable)', async () => {
    cleanups.push(
      registerWalkthroughMeasurer('coach-fab', () => new Promise(() => {})),
    );
    const renderer = await renderVisible();
    expect(textContent(renderer)).not.toContain('Every read starts here.');
    const backdrop = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Dismiss walkthrough' &&
        node.props.onPress !== undefined,
    )[0];
    expect(backdrop).toBeDefined();
    await act(async () => backdrop!.props.onPress());
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('a measurer registered while the tour is mid-retry is picked up on the next attempt', async () => {
    jest.useFakeTimers();
    let calls = 0;
    // First attempts measure null (layout settling); registration of a live
    // rect happens before attempt 3.
    cleanups.push(
      registerWalkthroughMeasurer('coach-fab', () => {
        calls += 1;
        return Promise.resolve(calls >= 3 ? SECOND : null);
      }),
    );
    const renderer = await renderVisible();
    expect(textContent(renderer)).not.toContain('Every read starts here.');
    await act(async () => {
      jest.advanceTimersByTime(130);
    });
    await act(async () => {
      jest.advanceTimersByTime(130);
    });
    expect(textContent(renderer)).toContain('Every read starts here.');
    expect(
      scrimPaths(renderer).some(d => d.includes(circleHoleStart(SECOND))),
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('unregister callback used as a React effect cleanup shape: calling it with args or as a method is harmless', () => {
    const { cleanup } = register('coach-fab', FIRST);
    const detached = cleanup;
    expect(() =>
      (detached as (...a: unknown[]) => void)(1, 2, 3),
    ).not.toThrow();
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
  });
});

describe('useWalkthroughTarget — key change (attack 3)', () => {
  it('switching the key moves the registration and cleans the old one', async () => {
    const node = fakeNode(() => [5, 6, 7, 8]);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <TargetOwner targetKey="coach-fab" node={node} />,
      );
    });
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toEqual({
      x: 5,
      y: 6,
      width: 7,
      height: 8,
    });
    await act(async () =>
      renderer.update(<TargetOwner targetKey="rank-banner" node={node} />),
    );
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
    expect(hasWalkthroughTarget('rank-banner')).toBe(true);
    act(() => renderer.unmount());
    expect(hasWalkthroughTarget('rank-banner')).toBe(false);
  });

  it('a component whose effect registers then throws in render on the next commit still cleans up', async () => {
    let explode = false;
    function Owner() {
      const ref = useWalkthroughTarget('coach-fab');
      if (explode) throw new Error('render boom');
      return <View ref={ref} />;
    }
    class Boundary extends React.Component<
      { children: React.ReactNode },
      { failed: boolean }
    > {
      state = { failed: false };
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <Boundary>
          <Owner />
        </Boundary>,
      );
    });
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);
    explode = true;
    await act(async () =>
      renderer.update(
        <Boundary>
          <Owner />
        </Boundary>,
      ),
    );
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
    errorSpy.mockRestore();
    act(() => renderer.unmount());
  });
});
