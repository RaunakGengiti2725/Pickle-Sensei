import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario 9 (native module fails to load on
 * foreground).
 *
 * `react-native-notify-kit` is made to throw from `require` (the lazy
 * `loadModule()` in notifications/service.ts), so `refreshPermission` cannot
 * read the permission when the app returns to the foreground. Expectations:
 *   - `syncNow` still runs after the failed permission check;
 *   - the store settles on permission 'unknown' (never a stale 'granted');
 *   - no unhandled promise rejection escapes `useNotificationBootstrap`;
 *   - the same holds for repeated background/foreground flips and for the
 *     Notifications screen's "Check again" path.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      throw new Error('no native sqlite in jest');
    },
    close() {},
  }),
}));

let mockRequireCount = 0;
jest.mock('react-native-notify-kit', () => {
  mockRequireCount += 1;
  throw new Error(
    "Cannot read property 'getNotificationSettings' of null (native module missing)",
  );
});

import { useNotificationBootstrap } from '../../../src/notifications/useNotificationBootstrap';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../../src/notifications/types';
import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const OWNER = canonicalDataOwner('dddddddd-dddd-4ddd-8ddd-dddddddddddd');

function Host({ owner }: { owner: string | null }) {
  useNotificationBootstrap(owner);
  return null;
}

declare const process: {
  on: (event: 'unhandledRejection', handler: (reason: unknown) => void) => void;
  off: (
    event: 'unhandledRejection',
    handler: (reason: unknown) => void,
  ) => void;
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

let appStateHandlers: Array<(state: string) => void> = [];

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  mockKvTable.clear();
  unhandled.length = 0;
  appStateHandlers = [];
  process.on('unhandledRejection', onUnhandled);
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      appStateHandlers.push(handler as (state: string) => void);
      return {
        remove: () => {
          appStateHandlers = appStateHandlers.filter(h => h !== handler);
        },
      } as ReturnType<typeof AppState.addEventListener>;
    });
  setActiveDataOwner(OWNER);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  jest.restoreAllMocks();
});

describe('scenario 9 — refreshPermission throws on foreground', () => {
  it('syncNow still runs, permission settles on unknown, nothing rejects unhandled', async () => {
    // Reminders were on and permission was granted in a previous process.
    mockKvTable.set(
      notificationPrefsKeyForOwner(OWNER),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        promptDismissed: true,
      }),
    );
    // Simulate a stale in-memory 'granted' from before the module broke.
    useNotificationStore.setState({ permission: 'granted' });

    const syncSpy = jest.fn();
    const originalSyncNow = useNotificationStore.getState().syncNow;
    useNotificationStore.setState({
      syncNow: async deps => {
        syncSpy();
        return originalSyncNow(deps);
      },
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Host owner={OWNER} />);
    });
    await flush();
    expect(appStateHandlers).toHaveLength(1);
    // Hydrate already hit the broken module once.
    expect(mockRequireCount).toBeGreaterThan(0);
    expect(useNotificationStore.getState().permission).toBe('unknown');
    const syncsAfterHydrate = syncSpy.mock.calls.length;

    // Background → foreground.
    act(() => {
      for (const handler of appStateHandlers) handler('background');
      for (const handler of appStateHandlers) handler('active');
    });
    await flush();

    expect(syncSpy.mock.calls.length).toBe(syncsAfterHydrate + 1);
    const state = useNotificationStore.getState();
    expect(state.permission).toBe('unknown');
    expect(state.hydrated).toBe(true);
    expect(state.prefs.enabled).toBe(true);
    // The schedule could not be reconciled either — surfaced, not hidden.
    expect(state.scheduleFailed).toBe(true);
    expect(unhandled).toEqual([]);

    // Ten rapid flips: still no rejection, still 'unknown'.
    for (let i = 0; i < 10; i += 1) {
      act(() => {
        for (const handler of appStateHandlers) handler('inactive');
        for (const handler of appStateHandlers) handler('active');
      });
    }
    await flush();
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(unhandled).toEqual([]);

    act(() => renderer.unmount());
    expect(appStateHandlers).toHaveLength(0);
    // A foreground event after unmount reaches no listener.
    useNotificationStore.setState({ syncNow: originalSyncNow });
  });

  it('the Notifications screen "Check again" path (refreshPermission → syncNow) does not reject either', async () => {
    useNotificationStore.setState({
      hydrated: true,
      ownerKey: OWNER,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      permission: 'granted',
    });
    const { refreshPermission, syncNow } = useNotificationStore.getState();
    const settled = await Promise.allSettled([
      refreshPermission().then(() => syncNow()),
    ]);
    expect(settled[0]!.status).toBe('fulfilled');
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(useNotificationStore.getState().scheduleFailed).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it('requestPermissionAndEnable with a broken module reports failure without enabling', async () => {
    useNotificationStore.setState({
      hydrated: true,
      ownerKey: OWNER,
      permission: 'undetermined',
    });
    const enabled = await useNotificationStore
      .getState()
      .requestPermissionAndEnable();
    expect(enabled).toBe(false);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(mockKvTable.has(notificationPrefsKeyForOwner(OWNER))).toBe(false);
    expect(unhandled).toEqual([]);
  });
});
