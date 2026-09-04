/**
 * Structural audit #2 (pass 1) — useConsistencyBootstrap wiring.
 *
 * No existing test imports the hook. Pins: hydrate per owner (and NOT for a
 * null owner), refresh on every return to 'active' only, and listener
 * removal on unmount (a leaked listener would keep refreshing a dead tree).
 */
import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

const mockHydrate = jest.fn(async () => undefined);
const mockRefresh = jest.fn(async () => undefined);
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (state: {
      hydrate: () => Promise<void>;
      refresh: () => Promise<void>;
    }) => unknown,
  ) => selector({ hydrate: mockHydrate, refresh: mockRefresh }),
}));

import { useConsistencyBootstrap } from '../../src/consistency/useConsistencyBootstrap';

type Listener = (state: AppStateStatus) => void;
const listeners = new Set<Listener>();
const removeSpy = jest.fn();

function Harness(props: { owner: string | null }) {
  useConsistencyBootstrap(props.owner);
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  listeners.clear();
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_type, handler) => {
      const listener = handler as Listener;
      listeners.add(listener);
      return {
        remove: () => {
          removeSpy();
          listeners.delete(listener);
        },
      };
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('audit: useConsistencyBootstrap', () => {
  it('hydrates once per owner, never for a null owner, and refreshes only on foreground', () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Harness owner={null} />);
    });
    expect(mockHydrate).not.toHaveBeenCalled();
    expect(listeners.size).toBe(1);

    act(() => {
      renderer.update(<Harness owner="owner-a" />);
    });
    expect(mockHydrate).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.update(<Harness owner="owner-a" />);
    });
    expect(mockHydrate).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.update(<Harness owner="owner-b" />);
    });
    expect(mockHydrate).toHaveBeenCalledTimes(2);

    act(() => {
      for (const l of listeners) l('background');
      for (const l of listeners) l('inactive');
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    act(() => {
      for (const l of listeners) l('active');
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    // Only one subscription is ever alive across re-renders.
    expect(listeners.size).toBe(1);

    act(() => renderer.unmount());
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    act(() => {
      for (const l of listeners) l('active');
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
