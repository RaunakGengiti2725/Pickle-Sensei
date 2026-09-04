/**
 * Execution audit — walkthrough target measurement and ceremony yielding.
 *
 * `useWalkthroughTarget` (src/walkthrough/targets.ts) had no direct coverage:
 * the real `measureInWindow` contract (valid rect → rect; NaN / zero-size /
 * unmounted / non-measurable node → null; throwing measurer → null) is pinned
 * here through a host ref, together with `walkthroughYieldsTo` queue/raise
 * and unsubscribe semantics, and `maybeShowFirstRun` across the empty /
 * unreadable / unwritable KV states.
 */
import React, { useEffect } from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockKv = new Map<string, string>();
let mockGetKvFails = false;
let mockSetKvFails = false;

jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => {
    if (mockGetKvFails) throw new Error('kv unreadable');
    return mockKv.get(key) ?? null;
  },
  setKv: async (_db: unknown, key: string, value: string) => {
    if (mockSetKvFails) throw new Error('kv unwritable');
    mockKv.set(key, value);
  },
}));

import {
  hasWalkthroughTarget,
  measureWalkthroughTarget,
  registerWalkthroughMeasurer,
  useWalkthroughTarget,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import {
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
  useWalkthroughStore,
  walkthroughYieldsTo,
} from '../../src/walkthrough/walkthroughStore';

type Measure = (
  cb: (x: number, y: number, width: number, height: number) => void,
) => void;

function Target(props: {
  target: WalkthroughTargetKey;
  node: { measureInWindow?: Measure } | null;
}) {
  const ref = useWalkthroughTarget(props.target);
  useEffect(() => {
    // Stand in for the host view the arrow points at.
    (ref as { current: unknown }).current = props.node;
  }, [ref, props.node]);
  return <View />;
}

function mount(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

afterEach(() => {
  useWalkthroughStore.setState({ visible: false, queued: false });
  mockKv.clear();
  mockGetKvFails = false;
  mockSetKvFails = false;
});

describe('useWalkthroughTarget → measureWalkthroughTarget', () => {
  it('registers on mount, measures a laid-out view, and unregisters on unmount', async () => {
    const node = {
      measureInWindow: (cb: Parameters<Measure>[0]) => cb(12, 340, 88, 56),
    };
    const renderer = mount(<Target target="coach-fab" node={node} />);
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toEqual({
      x: 12,
      y: 340,
      width: 88,
      height: 56,
    });
    act(() => renderer.unmount());
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
    await expect(measureWalkthroughTarget('coach-fab')).resolves.toBeNull();
  });

  it.each([
    ['zero width (hidden tab screen)', [0, 0, 0, 44]],
    ['zero height', [10, 10, 120, 0]],
    ['NaN origin', [Number.NaN, 20, 100, 44]],
    ['infinite size', [10, 20, Number.POSITIVE_INFINITY, 44]],
  ] as const)(
    'measures null for %s so the step is skipped',
    async (_label, dims) => {
      const node = {
        measureInWindow: (cb: Parameters<Measure>[0]) =>
          cb(dims[0], dims[1], dims[2], dims[3]),
      };
      const renderer = mount(<Target target="rank-banner" node={node} />);
      await expect(measureWalkthroughTarget('rank-banner')).resolves.toBeNull();
      act(() => renderer.unmount());
    },
  );

  it('measures null when the ref is empty or the node cannot measure', async () => {
    const renderer = mount(<Target target="tab-library" node={null} />);
    await expect(measureWalkthroughTarget('tab-library')).resolves.toBeNull();
    act(() => renderer.update(<Target target="tab-library" node={{}} />));
    await expect(measureWalkthroughTarget('tab-library')).resolves.toBeNull();
    act(() => renderer.unmount());
  });

  it('a throwing measurer never takes the tour down', async () => {
    const off = registerWalkthroughMeasurer('tab-progress', () =>
      Promise.reject(new Error('native view gone')),
    );
    await expect(measureWalkthroughTarget('tab-progress')).resolves.toBeNull();
    off();
    const offSync = registerWalkthroughMeasurer('tab-progress', () => {
      throw new Error('sync failure');
    });
    await expect(measureWalkthroughTarget('tab-progress')).resolves.toBeNull();
    offSync();
  });

  it('last writer wins and a stale predecessor cleanup cannot delete the newer measurer', () => {
    const first = registerWalkthroughMeasurer('coach-fab', async () => null);
    const second = registerWalkthroughMeasurer('coach-fab', async () => null);
    first();
    expect(hasWalkthroughTarget('coach-fab')).toBe(true);
    second();
    expect(hasWalkthroughTarget('coach-fab')).toBe(false);
  });
});

describe('walkthroughYieldsTo + maybeShowFirstRun', () => {
  function ceremony() {
    let showing = false;
    const listeners = new Set<() => void>();
    return {
      target: {
        isShowing: () => showing,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      set(next: boolean) {
        showing = next;
        listeners.forEach(l => l());
      },
      listenerCount: () => listeners.size,
    };
  }

  it('first run: writes the seen record BEFORE raising, then never raises again', async () => {
    await act(async () => {
      await useWalkthroughStore.getState().maybeShowFirstRun();
    });
    expect(mockKv.get(WALKTHROUGH_KV_KEY)).toBe(WALKTHROUGH_SEEN_VALUE);
    expect(useWalkthroughStore.getState().visible).toBe(true);
    useWalkthroughStore.getState().dismiss();
    await act(async () => {
      await useWalkthroughStore.getState().maybeShowFirstRun();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('unreadable or unwritable device state → no tour (never a launch loop)', async () => {
    mockGetKvFails = true;
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    mockGetKvFails = false;
    mockSetKvFails = true;
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);
    expect(mockKv.has(WALKTHROUGH_KV_KEY)).toBe(false);
  });

  it('concurrent first-run checks are serialized into a single show', async () => {
    await Promise.all([
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
    ]);
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: true,
      queued: false,
    });
  });

  it('queues behind a showing ceremony and raises when it dismisses; unsubscribe detaches', async () => {
    const c = ceremony();
    const off = walkthroughYieldsTo(c.target);
    c.set(true);
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: false,
      queued: true,
    });
    // Ceremony state changes while still showing do not raise the tour.
    c.set(true);
    expect(useWalkthroughStore.getState().visible).toBe(false);
    c.set(false);
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: true,
      queued: false,
    });

    useWalkthroughStore.getState().dismiss();
    off();
    expect(c.listenerCount()).toBe(0);
    c.set(true);
    // Detached ceremonies no longer block a replay.
    useWalkthroughStore.getState().replay();
    expect(useWalkthroughStore.getState().visible).toBe(true);
  });

  it('replay while a ceremony shows queues instead of overlapping', () => {
    const c = ceremony();
    const off = walkthroughYieldsTo(c.target);
    c.set(true);
    useWalkthroughStore.getState().replay();
    expect(useWalkthroughStore.getState()).toMatchObject({
      visible: false,
      queued: true,
    });
    c.set(false);
    expect(useWalkthroughStore.getState().visible).toBe(true);
    off();
  });
});
