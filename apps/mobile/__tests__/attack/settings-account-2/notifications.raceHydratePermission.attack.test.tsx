/**
 * ADVERSARIAL PASS 3 — mobile-settings-account #2 (target 4d812e1a).
 *
 * The real `notificationStore`, `NotificationSettingsScreen` and
 * `NotificationPrimingCard` against a fake OS scheduler that models what the
 * device actually holds (an id → notification map) and lets each applyPlan
 * be parked on a deferred promise.
 *
 *   S2  foreground syncNow interleaved with Settings setPrefs; applyPlan
 *       parked; cancelAllPlanned counted → the device must end up holding
 *       exactly the LAST plan (no duplicates, no missing ids, no stale time).
 *   S5  the kv SELECT throws during hydrate → hydrated with defaults (pinned)
 *       and what that means for the priming card and the persisted prefs.
 *   S7  {enabled:true} persisted, permission 'undetermined', hydrate, render
 *       the settings screen → a recovery affordance must exist.
 *
 * Every test name states whether it HELD or is BROKEN on 4d812e1a.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../../src/notifications/types';
import type { NotificationPlanContext } from '../../../src/notifications/plan';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
let mockSelectFailures = 0; // remaining kv SELECTs that throw
let mockSelectCalls = 0;

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        mockSelectCalls += 1;
        if (mockSelectFailures > 0) {
          mockSelectFailures -= 1;
          throw new Error('sqlite: database is locked (SQLITE_BUSY)');
        }
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

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface ApplyCall {
  plan: PlannedNotification[];
  gate: ReturnType<typeof deferred<void>>;
}

/**
 * Models the OS notification center the way `NotifeeScheduler` drives it:
 * applyPlan = (await gate) → cancelAllPlanned() → create each id (same id
 * replaces). Ids are keyed exactly like the tray, so duplicates cannot hide.
 */
class FakeDeviceScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  permissionStateError: Error | null = null;
  requestResult: PermissionState = 'granted';
  device = new Map<string, PlannedNotification>();
  applyCalls: ApplyCall[] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  openSettingsCalls = 0;
  /** When false, applyPlan resolves immediately (no parking). */
  park = true;

  async permissionState(): Promise<PermissionState> {
    if (this.permissionStateError) throw this.permissionStateError;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    const call: ApplyCall = { plan: [...plan], gate: deferred<void>() };
    this.applyCalls.push(call);
    if (this.park) await call.gate.promise;
    await this.cancelAllPlanned();
    for (const item of plan) {
      await Promise.resolve(); // one native hop per create, like the real one
      this.device.set(item.id, item);
    }
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
    for (const id of [...this.device.keys()]) {
      await Promise.resolve();
      if (id.startsWith('ps.')) this.device.delete(id);
    }
  }
  async openSystemSettings(): Promise<void> {
    this.openSettingsCalls += 1;
  }
  deviceIds(): string[] {
    return [...this.device.keys()].sort();
  }
}

const mockScheduler = new FakeDeviceScheduler();
jest.mock('../../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

jest.mock('../../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 2,
    trainedToday: false,
    totalActivities: 5,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { NotificationSettingsScreen } from '../../../src/screens/NotificationSettingsScreen';
import { NotificationPrimingCard } from '../../../src/notifications/NotificationPrimingCard';
import { Button } from '../../../src/design/components';

const owner = '55555555-5555-4555-8555-555555555555';

const context: NotificationPlanContext = {
  nowMs: 0,
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};
const loadContext = async () => ({ ...context, nowMs: Date.now() });

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
}

function resetScheduler() {
  mockScheduler.permission = 'granted';
  mockScheduler.permissionStateError = null;
  mockScheduler.requestResult = 'granted';
  mockScheduler.device.clear();
  mockScheduler.applyCalls = [];
  mockScheduler.cancelAllCalls = 0;
  mockScheduler.requestCalls = 0;
  mockScheduler.openSettingsCalls = 0;
  mockScheduler.park = true;
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function storedPrefs() {
  return parseNotificationPrefs(
    mockKvTable.get(notificationPrefsKeyForOwner(owner)) ?? null,
  );
}

function persistPrefsFor(
  patch: Partial<typeof DEFAULT_NOTIFICATION_PREFS>,
): void {
  mockKvTable.set(
    notificationPrefsKeyForOwner(owner),
    JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, ...patch }),
  );
}

function textContent(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string')
        .join(''),
    )
    .join('\n');
}

function pressables(renderer: ReactTestRenderer) {
  return renderer.root
    .findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        typeof node.props.accessibilityLabel === 'string',
    )
    .map(node => String(node.props.accessibilityLabel));
}

function buttonLabels(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Button)
    .map(node => String(node.props.label));
}

async function flushReal() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

/** Renders, runs `body`, and ALWAYS unmounts (a failing expect must not
 * leak a mounted tree into the next test's beforeEach). */
async function withRendered(
  element: React.ReactElement,
  body: (renderer: ReactTestRenderer) => Promise<void>,
): Promise<void> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  await flushReal();
  try {
    await body(renderer);
  } finally {
    await act(async () => {
      renderer.unmount();
    });
  }
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  jest.setSystemTime(new Date(2026, 8, 4, 10, 0, 0));
  mockKvTable.clear();
  mockSelectFailures = 0;
  mockSelectCalls = 0;
  mockGoBack.mockReset();
  mockNavigate.mockReset();
  resetScheduler();
  resetStore();
  setActiveDataOwner(owner);
});

afterEach(() => {
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('S2 — foreground syncNow interleaved with Settings setPrefs (applyPlan parked)', () => {
  async function hydrateEnabled() {
    persistPrefsFor({ enabled: true, promptDismissed: true });
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    expect(useNotificationStore.getState().hydrated).toBe(true);
    expect(mockScheduler.applyCalls).toHaveLength(1);
    expect(mockScheduler.deviceIds()).toHaveLength(6);
    mockScheduler.park = true;
  }

  it('[BROKEN on 4d812e1a] foreground sync in flight, user changes the reminder time; the OS answers the newer plan first → the device keeps the STALE plan', async () => {
    await hydrateEnabled();
    const store = useNotificationStore.getState();

    // 1. Foreground: refreshPermission().then(syncNow) — the OS call parks.
    const foreground = store.syncNow({ loadContext });
    await settle();
    expect(mockScheduler.applyCalls).toHaveLength(2);
    const stalePlan = mockScheduler.applyCalls[1]!;

    // 2. Settings: the player moves the practice nudge to 07:30.
    const settings = store.setPrefs(
      { practiceReminderMinutes: 7 * 60 + 30 },
      {
        loadContext,
      },
    );
    await settle();
    expect(mockScheduler.applyCalls).toHaveLength(3);
    const freshPlan = mockScheduler.applyCalls[2]!;
    expect(storedPrefs().practiceReminderMinutes).toBe(7 * 60 + 30);

    // 3. The OS completes the newer request first, then the older one.
    const cancelsBefore = mockScheduler.cancelAllCalls;
    freshPlan.gate.resolve();
    await settings;
    stalePlan.gate.resolve();
    await foreground;
    expect(mockScheduler.cancelAllCalls).toBe(cancelsBefore + 2);

    const lastPlan = freshPlan.plan;
    const expectedIds = lastPlan.map(item => item.id).sort();
    const deviceIds = mockScheduler.deviceIds();
    const practiceOnDevice = mockScheduler.device.get('ps.reminder.practice')!;
    const practiceInLastPlan = lastPlan.find(
      item => item.id === 'ps.reminder.practice',
    )!;
    expect(new Set(deviceIds).size).toBe(deviceIds.length); // no duplicates
    expect(deviceIds).toEqual(expectedIds); // no missing ids
    expect({
      deviceTime: new Date(practiceOnDevice.timestampMs).toString(),
      lastPlanTime: new Date(practiceInLastPlan.timestampMs).toString(),
      scheduleFailed: useNotificationStore.getState().scheduleFailed,
    }).toEqual({
      deviceTime: new Date(practiceInLastPlan.timestampMs).toString(),
      lastPlanTime: new Date(practiceInLastPlan.timestampMs).toString(),
      scheduleFailed: false,
    });
  });

  it('[BROKEN on 4d812e1a] foreground sync in flight, user turns ALL reminders OFF; the OS answers the cancel first → six reminders come back on a device the player just silenced', async () => {
    await hydrateEnabled();
    const store = useNotificationStore.getState();

    const foreground = store.syncNow({ loadContext });
    await settle();
    const stalePlan = mockScheduler.applyCalls[1]!;

    const off = store.setPrefs({ enabled: false }, { loadContext });
    await off; // the cancel path is not parked — it completes immediately
    expect(storedPrefs().enabled).toBe(false);
    expect(mockScheduler.deviceIds()).toEqual([]);

    stalePlan.gate.resolve();
    await foreground;

    expect({
      prefsEnabled: useNotificationStore.getState().prefs.enabled,
      deviceIds: mockScheduler.deviceIds(),
      scheduleFailed: useNotificationStore.getState().scheduleFailed,
    }).toEqual({ prefsEnabled: false, deviceIds: [], scheduleFailed: false });
  });

  it('control: when the OS answers the two requests in issue order the device holds exactly the last plan (HELD)', async () => {
    await hydrateEnabled();
    const store = useNotificationStore.getState();
    const foreground = store.syncNow({ loadContext });
    await settle();
    const first = mockScheduler.applyCalls[1]!;
    const settings = store.setPrefs(
      { practiceReminderMinutes: 7 * 60 + 30 },
      {
        loadContext,
      },
    );
    await settle();
    const second = mockScheduler.applyCalls[2]!;
    first.gate.resolve();
    await foreground;
    second.gate.resolve();
    await settings;
    const lastPlan = second.plan;
    expect(mockScheduler.deviceIds()).toEqual(
      lastPlan.map(item => item.id).sort(),
    );
    expect(mockScheduler.device.get('ps.reminder.practice')!.timestampMs).toBe(
      lastPlan.find(item => item.id === 'ps.reminder.practice')!.timestampMs,
    );
  });

  it('twelve rapid stepper taps (+30m ×12) with the OS answering in random order — seed 20260904 — leave the device on the last plan? (recorded; BROKEN on 4d812e1a when any out-of-order completion occurs)', async () => {
    await hydrateEnabled();
    const store = useNotificationStore.getState();
    let seed = 20260904;
    const rand = () => {
      // xorshift32 — deterministic, recorded seed.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    const taps: Promise<void>[] = [];
    let minutes = DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes;
    for (let i = 0; i < 12; i += 1) {
      minutes = (minutes + 30) % (24 * 60);
      taps.push(
        store.setPrefs({ practiceReminderMinutes: minutes }, { loadContext }),
      );
      await settle();
    }
    const pending = mockScheduler.applyCalls.slice(1);
    expect(pending).toHaveLength(12);
    const order = pending.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (const index of order) pending[index]!.gate.resolve();
    await Promise.all(taps);
    const lastPlan = pending[pending.length - 1]!.plan;
    const practice = lastPlan.find(item => item.id === 'ps.reminder.practice')!;
    expect(storedPrefs().practiceReminderMinutes).toBe(minutes);
    expect(mockScheduler.deviceIds()).toEqual(
      lastPlan.map(item => item.id).sort(),
    );
    expect({
      completionOrder: order,
      deviceTime: new Date(
        mockScheduler.device.get('ps.reminder.practice')!.timestampMs,
      ).toString(),
    }).toEqual({
      completionOrder: order,
      deviceTime: new Date(practice.timestampMs).toString(),
    });
  });
});

describe('S5 — the kv SELECT throws during hydrate', () => {
  it('hydrated flips to true with DEFAULT prefs and the schedule is cancelled (pinned behaviour — HELD as written)', async () => {
    persistPrefsFor({ enabled: true, promptDismissed: true });
    mockSelectFailures = 1;
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    const state = useNotificationStore.getState();
    expect(mockSelectCalls).toBe(1);
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(owner);
    expect(state.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(state.permission).toBe('granted');
    // Consequence of the defaults: the enabled player's reminders are
    // cancelled on the device because one SELECT failed.
    expect(mockScheduler.cancelAllCalls).toBe(1);
    expect(mockScheduler.applyCalls).toHaveLength(0);
  });

  it('[BROKEN on 4d812e1a] after a single failed SELECT the priming card re-appears for a player who already answered it', async () => {
    persistPrefsFor({
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 7 * 60 + 30,
    });
    mockSelectFailures = 1;
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    await withRendered(<NotificationPrimingCard />, async renderer => {
      const card = renderer.root.findAll(
        node => node.props.testID === 'notification-priming-card',
      );
      // The card "never re-nags" per its own doc comment.
      expect({ primingCardShown: card.length > 0 }).toEqual({
        primingCardShown: false,
      });
    });
  });

  it('[BROKEN on 4d812e1a] the same failed SELECT + "Not now" tap destroys the saved preferences (durable data loss from a transient read error)', async () => {
    persistPrefsFor({
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: 7 * 60 + 30,
    });
    mockSelectFailures = 1;
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    await withRendered(<NotificationPrimingCard />, async renderer => {
      const notNow = renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Not now' &&
          typeof node.props.onPress === 'function',
      );
      if (notNow.length > 0) {
        await act(async () => {
          notNow[0]!.props.onPress();
        });
        await flushReal();
      }
    });
    // The kv is healthy again: what survived on disk?
    const saved = storedPrefs();
    expect({
      enabled: saved.enabled,
      practiceReminderMinutes: saved.practiceReminderMinutes,
      promptDismissed: saved.promptDismissed,
    }).toEqual({
      enabled: true,
      practiceReminderMinutes: 7 * 60 + 30,
      promptDismissed: true,
    });
  });

  it('a second hydrate with the kv healthy restores the saved prefs and re-applies the plan (HELD — recovery exists on the next owner change)', async () => {
    persistPrefsFor({ enabled: true, promptDismissed: true });
    mockSelectFailures = 1;
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    await useNotificationStore.getState().hydrate({ loadContext });
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(mockScheduler.deviceIds()).toHaveLength(6);
  });
});

describe('S7 — {enabled:true} persisted, permission "undetermined", NotificationSettingsScreen', () => {
  it('[BROKEN on 4d812e1a] the screen must offer a recovery affordance (prompt / open settings), not only the paused caption', async () => {
    persistPrefsFor({ enabled: true, promptDismissed: true });
    mockScheduler.permission = 'undetermined';
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    const state = useNotificationStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.prefs.enabled).toBe(true);
    expect(state.permission).toBe('undetermined');
    // Nothing is scheduled: the store treats anything but 'granted' as off.
    expect(mockScheduler.deviceIds()).toEqual([]);

    await withRendered(<NotificationSettingsScreen />, async renderer => {
      const copy = textContent(renderer);
      const labels = [...buttonLabels(renderer), ...pressables(renderer)];
      expect(copy).toContain('Paused until notifications are allowed');
      const recoveryAffordance = labels.filter(label =>
        /turn on|allow|check again|open system settings|enable|request/i.test(
          label,
        ),
      );
      expect({ labels, recoveryAffordance }).toMatchObject({
        recoveryAffordance: expect.arrayContaining([expect.any(String)]),
      });
    });
  });

  it('control: the same state with permission "unknown" (probe failed) DOES render "Check again" (HELD)', async () => {
    persistPrefsFor({ enabled: true, promptDismissed: true });
    mockScheduler.permissionStateError = new Error('notifee unavailable');
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    expect(useNotificationStore.getState().permission).toBe('unknown');
    await withRendered(<NotificationSettingsScreen />, async renderer => {
      expect(buttonLabels(renderer)).toContain('Check again');
      expect(textContent(renderer)).toContain(
        'Couldn’t check notification permission',
      );
    });
  });

  it('from the undetermined state the master switch must be turned OFF before any control that prompts appears; nothing on the enabled screen requests permission (documents the trap — HELD as a description)', async () => {
    persistPrefsFor({ enabled: true, promptDismissed: true });
    mockScheduler.permission = 'undetermined';
    mockScheduler.park = false;
    await useNotificationStore.getState().hydrate({ loadContext });
    await withRendered(<NotificationSettingsScreen />, async renderer => {
      expect(buttonLabels(renderer)).not.toContain('Turn on reminders');
      const toggles = renderer.root.findAll(
        node =>
          node.props.label === 'All reminders' &&
          typeof node.props.onValueChange === 'function',
      );
      expect(toggles.length).toBeGreaterThan(0);
      await act(async () => {
        toggles[0]!.props.onValueChange(false);
      });
      await flushReal();
      expect(useNotificationStore.getState().prefs.enabled).toBe(false);
      // Off → the enable card with "Turn on reminders" (this DOES prompt).
      expect(buttonLabels(renderer)).toContain('Turn on reminders');
      expect(mockScheduler.requestCalls).toBe(0);
    });
  });
});
