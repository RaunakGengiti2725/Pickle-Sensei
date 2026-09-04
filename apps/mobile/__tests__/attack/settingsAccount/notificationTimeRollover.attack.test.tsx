import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 / tester #4 — scenario 1 (reminder time rollover).
 *
 * practiceReminderMinutes = 1439 (11:59 PM) is persisted in KV. The player
 * opens Notifications and taps "+30m". The display must wrap to 00:29
 * (rendered by the app's 12-hour formatter as "12:29 AM"), the durable row
 * must hold 29, and the plan must schedule the practice nudge for TOMORROW
 * 00:29 with at least 90 s of lead time — never today's (already past) 00:29
 * and never a time inside the lead window.
 *
 * Extras: clock skew right at the lead boundary, the "−30m" wrap below zero,
 * corrupt/huge minute values in KV.
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
      // Any other table (consistency snapshot reads) is absent in jest.
      throw new Error('no native sqlite in jest');
    },
    close() {},
  }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(() => callback(), [callback]);
  },
}));

const mockAppliedPlans: PlannedNotification[][] = [];
let mockPermission: PermissionState = 'granted';
jest.mock('../../../src/notifications/service', () => {
  const actual = jest.requireActual<
    typeof import('../../../src/notifications/service')
  >('../../../src/notifications/service');
  return {
    ...actual,
    getScheduler: () => ({
      async permissionState() {
        return mockPermission;
      },
      async requestPermission() {
        return mockPermission;
      },
      async applyPlan(plan: readonly PlannedNotification[]) {
        mockAppliedPlans.push([...plan]);
      },
      async cancelAllPlanned() {},
      async openSystemSettings() {},
    }),
  };
});

import type { PermissionState } from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  formatReminderMinutes,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../../src/notifications/types';
import { buildNotificationPlan } from '../../../src/notifications/plan';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { NotificationSettingsScreen } from '../../../src/screens/NotificationSettingsScreen';
import {
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const OWNER = canonicalDataOwner('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const MIN_LEAD_MS = 90_000;

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotificationSettingsScreen />);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function pressLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function reminderTimeLabel(renderer: TestRenderer.ReactTestRenderer): string {
  const nodes = renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Reminder time '),
  );
  expect(nodes.length).toBeGreaterThan(0);
  return String(nodes[0]!.props.accessibilityLabel).replace(
    'Reminder time ',
    '',
  );
}

function localMinutes(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function seedRow(minutes: number | string) {
  mockKvTable.set(
    notificationPrefsKeyForOwner(OWNER),
    JSON.stringify({
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      promptDismissed: true,
      practiceReminderMinutes: minutes,
    }),
  );
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

beforeEach(() => {
  mockKvTable.clear();
  mockAppliedPlans.length = 0;
  mockPermission = 'granted';
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
  act(() => mounted?.unmount());
  mounted = null;
  jest.restoreAllMocks();
});

describe('scenario 1 — 11:59 PM + 30 minutes', () => {
  it('display wraps to 12:29 AM, row stores 29, plan rolls to tomorrow with ≥90s lead', async () => {
    // "Now" is 10:00 local so today's 00:29 is already in the past.
    const now = new Date(2026, 7, 25, 10, 0, 0).getTime();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    seedRow(1439);
    await useNotificationStore.getState().hydrate();
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      1439,
    );

    const renderer = renderScreen();
    mounted = renderer;
    await flush();
    expect(reminderTimeLabel(renderer)).toBe('11:59 PM');
    const plansBefore = mockAppliedPlans.length;

    await act(async () => {
      pressLabel(renderer, 'Reminder 30 minutes later').props.onPress();
    });
    await flush();

    // 1439 + 30 wraps to 29 → 00:29, rendered 12-hour.
    expect(reminderTimeLabel(renderer)).toBe('12:29 AM');
    expect(formatReminderMinutes(29)).toBe('12:29 AM');
    const row = parseNotificationPrefs(
      mockKvTable.get(notificationPrefsKeyForOwner(OWNER)) ?? null,
    );
    expect(row.practiceReminderMinutes).toBe(29);

    // Exactly one new plan for the tap, carrying the practice nudge.
    expect(mockAppliedPlans.length).toBe(plansBefore + 1);
    const plan = mockAppliedPlans.at(-1)!;
    const practice = plan.find(n => n.id === 'ps.reminder.practice');
    expect(practice).toBeDefined();
    expect(practice!.repeat).toBe('daily');
    expect(localMinutes(practice!.timestampMs)).toBe(29);
    // Rolled to TOMORROW (not today's already-past 00:29) with ≥ 90 s lead.
    expect(startOfLocalDay(practice!.timestampMs)).toBe(
      startOfLocalDay(now) + 24 * 60 * 60 * 1000,
    );
    expect(practice!.timestampMs - now).toBeGreaterThanOrEqual(MIN_LEAD_MS);
  });

  it('clock skew: 00:28:00 → today’s 00:29 is inside the lead window, so tomorrow', () => {
    const prefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      practiceReminderMinutes: 29,
    };
    const context = {
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: false,
    };
    const at = (h: number, m: number, s: number) =>
      new Date(2026, 7, 25, h, m, s).getTime();

    // 60 s of lead is too little → tomorrow.
    const tight = buildNotificationPlan(prefs, {
      ...context,
      nowMs: at(0, 28, 0),
    }).find(n => n.id === 'ps.reminder.practice')!;
    expect(tight.timestampMs - at(0, 28, 0)).toBeGreaterThanOrEqual(
      MIN_LEAD_MS,
    );
    expect(startOfLocalDay(tight.timestampMs)).toBe(
      startOfLocalDay(at(0, 28, 0)) + 24 * 60 * 60 * 1000,
    );

    // Exactly 90 s of lead is allowed → today.
    const boundary = buildNotificationPlan(prefs, {
      ...context,
      nowMs: at(0, 27, 30),
    }).find(n => n.id === 'ps.reminder.practice')!;
    expect(boundary.timestampMs).toBe(at(0, 29, 0));

    // One second less than the lead window → tomorrow.
    const under = buildNotificationPlan(prefs, {
      ...context,
      nowMs: at(0, 27, 31),
    }).find(n => n.id === 'ps.reminder.practice')!;
    expect(startOfLocalDay(under.timestampMs)).toBe(
      startOfLocalDay(at(0, 27, 31)) + 24 * 60 * 60 * 1000,
    );
    expect(under.timestampMs - at(0, 27, 31)).toBeGreaterThanOrEqual(
      MIN_LEAD_MS,
    );

    // A skewed clock far in the past still yields a future timestamp.
    const skewed = buildNotificationPlan(prefs, {
      ...context,
      nowMs: new Date(1999, 0, 1, 23, 59, 59).getTime(),
    }).find(n => n.id === 'ps.reminder.practice')!;
    expect(skewed.timestampMs).toBeGreaterThan(
      new Date(1999, 0, 1, 23, 59, 59).getTime() + MIN_LEAD_MS,
    );
  });

  it('−30m from 00:00 wraps to 11:30 PM (never negative), and rapid repeats stay in range', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date(2026, 7, 25, 10, 0, 0).getTime());
    seedRow(0);
    await useNotificationStore.getState().hydrate();
    const renderer = renderScreen();
    mounted = renderer;
    await flush();
    expect(reminderTimeLabel(renderer)).toBe('12:00 AM');

    await act(async () => {
      pressLabel(renderer, 'Reminder 30 minutes earlier').props.onPress();
    });
    await flush();
    expect(reminderTimeLabel(renderer)).toBe('11:30 PM');
    expect(useNotificationStore.getState().prefs.practiceReminderMinutes).toBe(
      1410,
    );

    // Rapid repeats: 100 discrete taps forward, each dispatched as its own
    // event (React re-renders between discrete touch events) with no wait
    // for the persist/sync promises in between.
    for (let i = 0; i < 100; i += 1) {
      act(() => {
        pressLabel(renderer, 'Reminder 30 minutes later').props.onPress();
      });
    }
    await flush();
    const minutes =
      useNotificationStore.getState().prefs.practiceReminderMinutes;
    expect(minutes).toBeGreaterThanOrEqual(0);
    expect(minutes).toBeLessThan(1440);
    expect(Number.isInteger(minutes)).toBe(true);
    // Every tap read the latest store value, so 100 × 30 min = 50 h → +2 h net.
    expect(minutes).toBe((1410 + 100 * 30) % 1440);
    const row = parseNotificationPrefs(
      mockKvTable.get(notificationPrefsKeyForOwner(OWNER)) ?? null,
    );
    expect(row.practiceReminderMinutes).toBe(minutes);
  });

  it('corrupt KV minutes (1440, -1, 1e9, NaN string, unicode) fall back to the default and stay steppable', async () => {
    const corrupt: Array<number | string> = [
      1440,
      -1,
      1e9,
      'NaN',
      '１７：３０',
      29.5,
    ];
    for (const value of corrupt) {
      mockKvTable.clear();
      seedRow(value);
      useNotificationStore.setState({ hydrated: false, ownerKey: null });
      await useNotificationStore.getState().hydrate();
      const minutes =
        useNotificationStore.getState().prefs.practiceReminderMinutes;
      expect(minutes).toBe(DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes);
      expect(() => formatReminderMinutes(minutes)).not.toThrow();
    }
    // Huge input straight into the formatter never throws or produces NaN.
    for (const huge of [
      Number.MAX_SAFE_INTEGER,
      -Number.MAX_SAFE_INTEGER,
      1e300,
    ]) {
      const label = formatReminderMinutes(huge);
      expect(label).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
    }
  });
});
