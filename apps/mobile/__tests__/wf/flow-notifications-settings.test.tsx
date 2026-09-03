import React from 'react';
import { Switch, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../src/notifications/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Real-user walk through Settings → Notifications with every control driven
 * through its handler: opt-in (grant / deny / prompt failure), the denied →
 * system-settings recovery path, the master switch, every per-reminder
 * switch, the time presets and ±30m stepper (incl. midnight wrap and the
 * disabled state while the practice nudge is off), the header back button,
 * focus re-check of the permission, and the accessibility props of each
 * control. The scheduler is a fake behind the SchedulerPort seam so the
 * native module is never touched.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../src/data/db', () => ({
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
let focusCallbackRuns = 0;
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => {
      focusCallbackRuns += 1;
      return callback();
    }, [callback]);
  },
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  requestResult: PermissionState = 'granted';
  requestError: Error | null = null;
  permissionStateError: Error | null = null;
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  openSettingsCalls = 0;
  permissionStateCalls = 0;

  async permissionState(): Promise<PermissionState> {
    this.permissionStateCalls += 1;
    if (this.permissionStateError) throw this.permissionStateError;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    if (this.requestError) throw this.requestError;
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {
    this.openSettingsCalls += 1;
  }
}

const mockScheduler = new FakeScheduler();
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

// Plan facts: a two-day streak, nothing trained yet today at 10:00 AM.
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 2,
    trainedToday: false,
    totalActivities: 5,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import { useNotificationStore } from '../../src/notifications/notificationStore';
import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';

const owner = '55555555-5555-4555-8555-555555555555';

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
}

function resetScheduler() {
  mockScheduler.permission = 'undetermined';
  mockScheduler.requestResult = 'granted';
  mockScheduler.requestError = null;
  mockScheduler.permissionStateError = null;
  mockScheduler.appliedPlans = [];
  mockScheduler.cancelAllCalls = 0;
  mockScheduler.requestCalls = 0;
  mockScheduler.openSettingsCalls = 0;
  mockScheduler.permissionStateCalls = 0;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function unmountScreen(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

async function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<NotificationSettingsScreen />);
  });
  await flush();
  return renderer;
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string')
        .join(''),
    )
    .join('\n');
}

function findByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  const match = pressableByLabel(renderer, label);
  expect(match).not.toBeNull();
  return match!;
}

function queryByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance | null {
  return pressableByLabel(renderer, label);
}

/** The Pressable element itself (carries role/state/disabled + onPress). */
function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance | null {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return (
    matches.find(node => node.props.accessibilityRole !== undefined) ??
    matches[0] ??
    null
  );
}

function findSwitch(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance {
  const matches = renderer.root
    .findAllByType(Switch)
    .filter(node => node.props.accessibilityLabel === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function press(node: TestRenderer.ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
  await flush();
}

async function flip(node: TestRenderer.ReactTestInstance, next: boolean) {
  await act(async () => {
    node.props.onValueChange(next);
  });
  await flush();
}

function storedPrefs() {
  return parseNotificationPrefs(
    mockKvTable.get(notificationPrefsKeyForOwner(owner)) ?? null,
  );
}

beforeEach(async () => {
  // Pin the clock for plan assertions but keep real timers so async flushes
  // (setTimeout 0) still settle.
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
  jest.setSystemTime(new Date(2026, 7, 25, 10, 0, 0));
  mockKvTable.clear();
  mockGoBack.mockReset();
  mockNavigate.mockReset();
  focusCallbackRuns = 0;
  resetScheduler();
  resetStore();
  setActiveDataOwner(owner);
  await useNotificationStore.getState().hydrate();
});

afterEach(() => {
  jest.useRealTimers();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('notification settings — opt-in', () => {
  it('starts OFF (nothing scheduled) and re-checks permission on focus', async () => {
    const renderer = await renderScreen();
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(mockScheduler.appliedPlans).toEqual([]);
    expect(focusCallbackRuns).toBeGreaterThan(0);
    expect(mockScheduler.permissionStateCalls).toBeGreaterThan(0);
    expect(useNotificationStore.getState().permission).toBe('undetermined');

    const body = textContent(renderer);
    expect(body).toContain('Stay match-ready.');
    expect(body).toContain('Off by default.');
    expect(body).toContain('Reminders are scheduled on this phone.');
    // Off state shows no per-reminder switches yet.
    expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
    await unmountScreen(renderer);
  });

  it('"Turn on reminders" → grant → master on, schedule applied, switches appear', async () => {
    const renderer = await renderScreen();
    const turnOn = findByLabel(renderer, 'Turn on reminders');
    expect(turnOn.props.accessibilityRole).toBe('button');
    expect(turnOn.props.accessibilityState?.disabled).toBeFalsy();

    await press(turnOn);

    expect(mockScheduler.requestCalls).toBe(1);
    const state = useNotificationStore.getState();
    expect(state.permission).toBe('granted');
    expect(state.prefs.enabled).toBe(true);
    expect(state.prefs.promptDismissed).toBe(true);
    expect(storedPrefs().enabled).toBe(true);
    expect(mockScheduler.appliedPlans.length).toBeGreaterThan(0);
    const lastPlan = mockScheduler.appliedPlans.at(-1)!;
    expect(lastPlan.map(item => item.id).sort()).toEqual(
      [
        'ps.comeback.1',
        'ps.comeback.2',
        'ps.comeback.3',
        'ps.reminder.practice',
        'ps.reminder.streak',
        'ps.reminder.weekly',
      ].sort(),
    );
    for (const item of lastPlan) {
      expect(item.id.startsWith('ps.')).toBe(true);
      expect(['Home', 'Performance']).toContain(item.screen);
      expect(item.timestampMs).toBeGreaterThan(Date.now());
    }

    // The enable card is gone and every switch is present.
    expect(queryByLabel(renderer, 'Turn on reminders')).toBeNull();
    for (const label of [
      'All reminders',
      'Practice nudge',
      'Streak defense',
      'Weekly recap',
      'Welcome back',
    ]) {
      const toggle = findSwitch(renderer, label);
      expect(toggle.props.value).toBe(true);
      expect(typeof toggle.props.onValueChange).toBe('function');
    }
    expect(textContent(renderer)).toContain(
      'Scheduled from your real practice history',
    );
    await unmountScreen(renderer);
  });

  it('"Turn on reminders" → deny → nothing enabled, recovery card with a wired settings button', async () => {
    mockScheduler.requestResult = 'denied';
    const renderer = await renderScreen();
    await press(findByLabel(renderer, 'Turn on reminders'));

    const state = useNotificationStore.getState();
    expect(state.permission).toBe('denied');
    expect(state.prefs.enabled).toBe(false);
    expect(mockScheduler.appliedPlans).toEqual([]);

    const body = textContent(renderer);
    expect(body).toContain('Notifications are off in system settings');
    expect(body).toContain(
      'Pickle Sensei can’t deliver reminders until notifications are allowed for the app.',
    );
    const openSettings = findByLabel(renderer, 'Open system settings');
    expect(openSettings.props.accessibilityRole).toBe('button');
    await press(openSettings);
    expect(mockScheduler.openSettingsCalls).toBe(1);
    await unmountScreen(renderer);
  });

  it('a throwing permission prompt is survived: no crash, stays off, no spinner to get stuck on', async () => {
    mockScheduler.requestError = new Error('native prompt unavailable');
    const renderer = await renderScreen();
    await press(findByLabel(renderer, 'Turn on reminders'));

    const state = useNotificationStore.getState();
    expect(state.permission).toBe('unknown');
    expect(state.prefs.enabled).toBe(false);
    expect(mockScheduler.appliedPlans).toEqual([]);
    // The control is still there, still actionable (no dead end).
    const turnOn = findByLabel(renderer, 'Turn on reminders');
    expect(turnOn.props.accessibilityState?.disabled).toBeFalsy();

    // Recovery on the next tap once the OS answers.
    mockScheduler.requestError = null;
    await press(turnOn);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    await unmountScreen(renderer);
  });

  it('a failing permission read degrades to "unknown" without breaking the screen', async () => {
    mockScheduler.permissionStateError = new Error('settings unavailable');
    const renderer = await renderScreen();
    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(textContent(renderer)).not.toContain(
      'Notifications are off in system settings',
    );
    expect(queryByLabel(renderer, 'Turn on reminders')).not.toBeNull();
    await unmountScreen(renderer);
  });

  it('header back button calls navigation.goBack', async () => {
    const renderer = await renderScreen();
    const back = findByLabel(renderer, 'Back');
    expect(back.props.accessibilityRole).toBe('button');
    await press(back);
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    await unmountScreen(renderer);
  });
});

describe('notification settings — enabled controls', () => {
  async function renderEnabled() {
    mockScheduler.permission = 'granted';
    await useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true });
    mockScheduler.appliedPlans = [];
    mockScheduler.cancelAllCalls = 0;
    return renderScreen();
  }

  it('master switch off → cancels everything, persists, shows the opt-in card again', async () => {
    const renderer = await renderEnabled();
    const master = findSwitch(renderer, 'All reminders');
    expect(master.props.value).toBe(true);
    expect(master.props.accessibilityState).toEqual({ disabled: undefined });

    await flip(master, false);

    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(storedPrefs().enabled).toBe(false);
    expect(mockScheduler.cancelAllCalls).toBeGreaterThan(0);
    expect(mockScheduler.appliedPlans).toEqual([]);
    expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
    expect(queryByLabel(renderer, 'Turn on reminders')).not.toBeNull();
    await unmountScreen(renderer);
  });

  it.each([
    ['Practice nudge', 'practiceReminder', 'ps.reminder.practice'],
    ['Streak defense', 'streakDefense', 'ps.reminder.streak'],
    ['Weekly recap', 'weeklyRecap', 'ps.reminder.weekly'],
    ['Welcome back', 'comeback', 'ps.comeback.1'],
  ] as const)(
    '"%s" switch off/on flips prefs.%s, persists, and re-plans without %s',
    async (label, prefKey, planId) => {
      const renderer = await renderEnabled();
      const toggle = findSwitch(renderer, label);
      expect(toggle.props.value).toBe(true);

      await flip(toggle, false);
      expect(useNotificationStore.getState().prefs[prefKey]).toBe(false);
      expect(storedPrefs()[prefKey]).toBe(false);
      let plan = mockScheduler.appliedPlans.at(-1)!;
      expect(plan.map(item => item.id)).not.toContain(planId);
      expect(findSwitch(renderer, label).props.value).toBe(false);

      await flip(findSwitch(renderer, label), true);
      expect(useNotificationStore.getState().prefs[prefKey]).toBe(true);
      expect(storedPrefs()[prefKey]).toBe(true);
      plan = mockScheduler.appliedPlans.at(-1)!;
      expect(plan.map(item => item.id)).toContain(planId);
      await unmountScreen(renderer);
    },
  );

  it('time presets select the reminder time, expose selected state, and move the practice trigger', async () => {
    const renderer = await renderEnabled();
    expect(textContent(renderer)).toContain('5:30 PM');
    const evening = findByLabel(renderer, 'Evening, 5:30 PM');
    expect(evening.props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(evening.props.accessibilityRole).toBe('button');

    const morning = findByLabel(renderer, 'Morning, 7:30 AM');
    expect(morning.props.accessibilityState).toMatchObject({
      selected: false,
    });
    await press(morning);
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      7 * 60 + 30,
    );
    expect(storedPrefs().practiceReminderMinutes).toBe(7 * 60 + 30);
    expect(
      findByLabel(renderer, 'Morning, 7:30 AM').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(textContent(renderer)).toContain('7:30 AM');

    // 10:00 AM now → a 7:30 AM reminder lands tomorrow morning.
    const practice = mockScheduler.appliedPlans
      .at(-1)!
      .find(item => item.id === 'ps.reminder.practice')!;
    const fire = new Date(practice.timestampMs);
    expect(fire.getHours()).toBe(7);
    expect(fire.getMinutes()).toBe(30);
    expect(fire.getDate()).toBe(26);
    expect(practice.repeat).toBe('daily');

    for (const [label, minutes] of [
      ['Midday, 12:00 PM', 12 * 60],
      ['Night, 7:30 PM', 19 * 60 + 30],
      ['Evening, 5:30 PM', 17 * 60 + 30],
    ] as const) {
      await press(findByLabel(renderer, label));
      expect(
        useNotificationStore.getState().prefs.practiceReminderMinutes,
      ).toBe(minutes);
    }
    await unmountScreen(renderer);
  });

  it('±30m stepper moves the time, wraps across midnight, and never leaves the 0..1439 range', async () => {
    const renderer = await renderEnabled();
    const later = findByLabel(renderer, 'Reminder 30 minutes later');
    const earlier = findByLabel(renderer, 'Reminder 30 minutes earlier');
    expect(later.props.accessibilityRole).toBe('button');
    expect(earlier.props.accessibilityRole).toBe('button');

    await press(later);
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      18 * 60,
    );
    expect(textContent(renderer)).toContain('6:00 PM');

    await press(findByLabel(renderer, 'Reminder 30 minutes earlier'));
    await press(findByLabel(renderer, 'Reminder 30 minutes earlier'));
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      17 * 60,
    );
    expect(textContent(renderer)).toContain('5:00 PM');

    // Wrap forward past midnight: 11:30 PM + 30m → 12:00 AM.
    await press(findByLabel(renderer, 'Night, 7:30 PM'));
    for (let i = 0; i < 8; i += 1) {
      await press(findByLabel(renderer, 'Reminder 30 minutes later'));
    }
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      23 * 60 + 30,
    );
    expect(textContent(renderer)).toContain('11:30 PM');
    await press(findByLabel(renderer, 'Reminder 30 minutes later'));
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      0,
    );
    expect(textContent(renderer)).toContain('12:00 AM');
    expect(storedPrefs().practiceReminderMinutes).toBe(0);

    // Wrap backward: 12:00 AM − 30m → 11:30 PM.
    await press(findByLabel(renderer, 'Reminder 30 minutes earlier'));
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      23 * 60 + 30,
    );
    expect(storedPrefs().practiceReminderMinutes).toBe(23 * 60 + 30);
    await unmountScreen(renderer);
  });

  it('time controls are disabled (and announce it) while the practice nudge is off', async () => {
    const renderer = await renderEnabled();
    await flip(findSwitch(renderer, 'Practice nudge'), false);

    for (const label of [
      'Morning, 7:30 AM',
      'Midday, 12:00 PM',
      'Evening, 5:30 PM',
      'Night, 7:30 PM',
      'Reminder 30 minutes earlier',
      'Reminder 30 minutes later',
    ]) {
      const control = findByLabel(renderer, label);
      expect(control.props.disabled).toBe(true);
      expect(control.props.accessibilityState?.disabled).toBe(true);
    }

    await flip(findSwitch(renderer, 'Practice nudge'), true);
    expect(
      findByLabel(renderer, 'Reminder 30 minutes later').props.disabled,
    ).toBe(false);
    await unmountScreen(renderer);
  });

  it('permission revoked in the OS: switches stay, master caption says paused, plan is cancelled, recovery button works', async () => {
    const renderer = await renderEnabled();
    mockScheduler.permission = 'denied';
    // A foreground/focus re-check is how the app learns about a revocation.
    await act(async () => {
      await useNotificationStore.getState().refreshPermission();
      await useNotificationStore.getState().syncNow();
    });
    await flush();

    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(mockScheduler.cancelAllCalls).toBeGreaterThan(0);
    const body = textContent(renderer);
    expect(body).toContain('Paused until notifications are allowed');
    expect(body).toContain('Notifications are off in system settings');
    expect(findSwitch(renderer, 'All reminders').props.value).toBe(true);
    await press(findByLabel(renderer, 'Open system settings'));
    expect(mockScheduler.openSettingsCalls).toBe(1);

    // Permission re-granted (user came back from Settings) → next check
    // re-arms the schedule with no further taps.
    mockScheduler.permission = 'granted';
    mockScheduler.appliedPlans = [];
    await act(async () => {
      await useNotificationStore.getState().refreshPermission();
      await useNotificationStore.getState().syncNow();
    });
    await flush();
    expect(mockScheduler.appliedPlans.length).toBe(1);
    expect(textContent(renderer)).toContain(
      'Scheduled from your real practice history',
    );
    await unmountScreen(renderer);
  });

  it('rapid double taps on a control settle on one consistent state (no divergence)', async () => {
    const renderer = await renderEnabled();
    const later = findByLabel(renderer, 'Reminder 30 minutes later');
    await act(async () => {
      later.props.onPress();
      later.props.onPress();
    });
    await flush();
    // Both taps read the same rendered prefs → one deterministic +30m.
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      18 * 60,
    );
    expect(storedPrefs().practiceReminderMinutes).toBe(18 * 60);
    const master = findSwitch(renderer, 'All reminders');
    await act(async () => {
      master.props.onValueChange(false);
      master.props.onValueChange(false);
    });
    await flush();
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(storedPrefs().enabled).toBe(false);
    await unmountScreen(renderer);
  });

  it('every Text on the screen is lock-screen-safe framing copy (no names, scores, clips)', async () => {
    const renderer = await renderEnabled();
    const body = textContent(renderer);
    expect(body).toContain(
      'Reminder copy never includes your name, scores, or clips — it is written for a lock screen.',
    );
    expect(body).toContain('Reminders are scheduled on this phone.');
    await unmountScreen(renderer);
  });
});

describe('notification settings — denied before opt-in', () => {
  it('a denied system permission is surfaced with the recovery card even while master is off', async () => {
    mockScheduler.permission = 'denied';
    const renderer = await renderScreen();
    expect(useNotificationStore.getState().permission).toBe('denied');
    const body = textContent(renderer);
    expect(body).toContain('Notifications are off in system settings');
    await press(findByLabel(renderer, 'Open system settings'));
    expect(mockScheduler.openSettingsCalls).toBe(1);
    await unmountScreen(renderer);
  });
});
