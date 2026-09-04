import React from 'react';
import { AppState } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario S5 against 4d812e1a.
 *
 * AppState background→active while the splash is still up (auth not yet
 * hydrated, `useNotificationBootstrap(null)`). The REAL hook + REAL store
 * run; only the scheduler port (Notifee) is a fake that keeps a set of
 * "pending trigger ids" the way the OS does across launches.
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
      return { rows: [] };
    },
    close() {},
  }),
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  /** Trigger ids the OS still holds from a previous run of the app. */
  pendingIds = new Set<string>();
  calls: string[] = [];
  requestCalls = 0;

  async permissionState(): Promise<PermissionState> {
    this.calls.push('permissionState');
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.calls.push('requestPermission');
    this.requestCalls += 1;
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.calls.push(`applyPlan:${plan.length}`);
    this.pendingIds = new Set(plan.map(item => item.id));
  }
  async cancelAllPlanned(): Promise<void> {
    this.calls.push('cancelAllPlanned');
    this.pendingIds.clear();
  }
  async openSystemSettings(): Promise<void> {}
}

const mockScheduler = new FakeScheduler();

jest.mock('../../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { useNotificationBootstrap } from '../../../src/notifications/useNotificationBootstrap';

const OWNER = '33333333-3333-4333-8333-333333333333';
const appStateListener = AppState.addEventListener as jest.Mock;

function Probe({ owner }: { owner: string | null }) {
  useNotificationBootstrap(owner);
  return null;
}

async function flush() {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    });
  }
}

function fireAppState(state: string) {
  for (const call of appStateListener.mock.calls as Array<
    [string, (s: string) => void]
  >) {
    if (call[0] === 'change') call[1](state);
  }
}

beforeEach(() => {
  mockKvTable.clear();
  appStateListener.mockClear();
  mockScheduler.calls = [];
  mockScheduler.requestCalls = 0;
  mockScheduler.pendingIds = new Set([
    'ps.reminder.practice',
    'ps.reminder.streak',
  ]);
  mockScheduler.permission = 'granted';
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('S5 — AppState background→active during the splash, owner still null', () => {
  it('never schedules and never prompts for a null owner (safety HOLDS)', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe owner={null} />);
    });
    await flush();
    expect(useNotificationStore.getState().hydrated).toBe(false);

    await act(async () => {
      fireAppState('background');
      fireAppState('inactive');
      fireAppState('active');
    });
    await flush();

    expect(mockScheduler.requestCalls).toBe(0);
    expect(mockScheduler.calls.filter(c => c.startsWith('applyPlan'))).toEqual(
      [],
    );
    expect(useNotificationStore.getState().hydrated).toBe(false);
    expect(useNotificationStore.getState().ownerKey).toBeNull();

    console.log(
      JSON.stringify({
        probe: 'S5/null-owner-foreground',
        schedulerCalls: mockScheduler.calls,
        pendingIdsAfter: [...mockScheduler.pendingIds],
      }),
    );
    act(() => renderer.unmount());
  });

  it('CONTRACT (fails on 4d812e1a): does not call syncNow (and so does not cancel the previous run\u2019s reminders) while the owner is unknown', async () => {
    const syncSpy = jest.fn(useNotificationStore.getState().syncNow);
    useNotificationStore.setState({ syncNow: syncSpy });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe owner={null} />);
    });
    await flush();
    await act(async () => {
      fireAppState('active');
    });
    await flush();
    // The scenario's expectation: no owner → no sync → the signed-in
    // account's reminders scheduled by the previous run stay pending.
    expect(syncSpy).not.toHaveBeenCalled();
    expect([...mockScheduler.pendingIds]).toEqual([
      'ps.reminder.practice',
      'ps.reminder.streak',
    ]);
    act(() => renderer.unmount());
  });

  it('self-heal check: once the owner hydrates with reminders ON + granted, the plan is re-applied', async () => {
    mockKvTable.set(
      notificationPrefsKeyForOwner(OWNER),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        promptDismissed: true,
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe owner={null} />);
    });
    await act(async () => {
      fireAppState('active');
    });
    await flush();
    const pendingAfterBlip = [...mockScheduler.pendingIds];

    setActiveDataOwner(OWNER);
    await act(async () => {
      renderer.update(<Probe owner={OWNER} />);
    });
    await flush();
    const state = useNotificationStore.getState();

    console.log(
      JSON.stringify({
        probe: 'S5/self-heal',
        pendingAfterBlip,
        pendingAfterHydrate: [...mockScheduler.pendingIds],
        schedulerCalls: mockScheduler.calls,
        hydrated: state.hydrated,
        ownerKey: state.ownerKey,
        enabled: state.prefs.enabled,
        permission: state.permission,
      }),
    );
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(OWNER);
    expect(mockScheduler.requestCalls).toBe(0);
    expect(mockScheduler.pendingIds.size).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });

  it('rapid repeats: 25 foreground blips with a null owner never prompt or schedule', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe owner={null} />);
    });
    await act(async () => {
      for (let i = 0; i < 25; i += 1) {
        fireAppState('background');
        fireAppState('active');
      }
    });
    await flush();
    expect(mockScheduler.requestCalls).toBe(0);
    expect(mockScheduler.calls.filter(c => c.startsWith('applyPlan'))).toEqual(
      [],
    );
    expect(useNotificationStore.getState().ownerKey).toBeNull();
    act(() => renderer.unmount());
  });
});
