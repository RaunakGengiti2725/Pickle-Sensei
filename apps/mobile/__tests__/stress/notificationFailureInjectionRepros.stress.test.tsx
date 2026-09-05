/**
 * Minimized reproductions of the defects the seeded failure-injection
 * campaigns (`notification*FailureInjection.stress.test.ts*`) found. Each
 * one is the smallest single fault that trips an invariant, written as
 * `it.failing`: the assertion states the EXPECTED behaviour, so the test
 * passes only while the defect is present. Once a fix lands Jest reports
 * the repro as failing — flip it to `it` and delete the matching
 * `KNOWN_FINDINGS` entry in test-support/stress/notifications/campaign.ts
 * so the campaigns enforce that invariant again.
 *
 *   NF-1  hydrate: kv read failure → silent defaults, schedule cancelled,
 *         next save overwrites the stored preferences
 *   NF-2  signed-out hydrate: failed cancelAllPlanned reported as success
 *   NF-3  NotifeeScheduler: malformed authorizationStatus → 'granted'
 *   NF-4  foreground PRESS event without `detail` throws in the listener
 *   NF-5  never-settling requestPermission → controls busy forever
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
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
import { KNOWN_FINDINGS } from '../../test-support/stress/notifications/campaign';

const REPRODUCED_FINDING_IDS = ['NF-1', 'NF-2', 'NF-3', 'NF-4', 'NF-5'];

const OWNER = '77777777-7777-4777-8777-777777777777';

const mockKvTable = new Map<string, string>();
let mockKvReadFails = false;
let mockKvWriteFails = false;
let mockKvReadFailsForKey: string | null = null;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const key = String(params[0]);
        if (mockKvReadFails || mockKvReadFailsForKey === key) {
          throw new Error('SQLITE_IOERR: disk I/O error');
        }
        const value = mockKvTable.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvWriteFails)
          throw new Error('SQLITE_FULL: database or disk is full');
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockScheduler = {
  permissionState: jest.fn<Promise<PermissionState>, []>(),
  requestPermission: jest.fn<Promise<PermissionState>, []>(),
  applyPlan: jest.fn<Promise<void>, [readonly PlannedNotification[]]>(),
  cancelAllPlanned: jest.fn<Promise<void>, []>(),
  openSystemSettings: jest.fn<Promise<void>, []>(),
};
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 0,
    trainedToday: false,
    totalActivities: 0,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
  useFocusEffect: () => {},
}));

const mockNotifee = {
  settings: { authorizationStatus: 1 } as { authorizationStatus?: unknown },
  foregroundListener: null as ((event: unknown) => void) | null,
};
jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  RepeatFrequency: { NONE: -1, HOURLY: 0, DAILY: 1, WEEKLY: 2 },
  TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
  EventType: { DISMISSED: 0, PRESS: 1, DELIVERED: 3 },
  default: {
    getNotificationSettings: async () => mockNotifee.settings,
    requestPermission: async () => mockNotifee.settings,
    createChannel: async () => 'reminders',
    createTriggerNotification: async () => 'id',
    getTriggerNotificationIds: async () => [],
    cancelTriggerNotification: async () => {},
    openNotificationSettings: async () => {},
    getInitialNotification: async () => null,
    onForegroundEvent: (listener: (event: unknown) => void) => {
      mockNotifee.foregroundListener = listener;
      return () => {
        mockNotifee.foregroundListener = null;
      };
    },
    onBackgroundEvent: () => {},
  },
}));

import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';
import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';

const realService = jest.requireActual<
  typeof import('../../src/notifications/service')
>('../../src/notifications/service');

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

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
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

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date(2026, 2, 3, 9, 0, 0));
  mockKvTable.clear();
  mockKvReadFails = false;
  mockKvWriteFails = false;
  mockKvReadFailsForKey = null;
  mockScheduler.permissionState.mockReset().mockResolvedValue('granted');
  mockScheduler.requestPermission.mockReset().mockResolvedValue('granted');
  mockScheduler.applyPlan.mockReset().mockResolvedValue(undefined);
  mockScheduler.cancelAllPlanned.mockReset().mockResolvedValue(undefined);
  mockScheduler.openSystemSettings.mockReset().mockResolvedValue(undefined);
  mockNotifee.settings = { authorizationStatus: 1 };
  mockNotifee.foregroundListener = null;
  setActiveDataOwner(OWNER);
  resetStore();
});

let mounted: TestRenderer.ReactTestRenderer | null = null;

async function render(
  element: React.ReactElement,
): Promise<TestRenderer.ReactTestRenderer> {
  await act(async () => {
    mounted = TestRenderer.create(element);
  });
  return mounted!;
}

afterEach(async () => {
  // `it.failing` bodies stop at the first assertion, so cleanup lives here.
  if (mounted) {
    const renderer = mounted;
    mounted = null;
    await act(async () => {
      renderer.unmount();
    });
  }
  jest.useRealTimers();
});

it('every KNOWN_FINDINGS entry has a minimized repro in this file', () => {
  const registered = [
    ...new Set(KNOWN_FINDINGS.map(finding => finding.id)),
  ].sort();
  expect(registered).toEqual(REPRODUCED_FINDING_IDS);
});

const SAVED_ENABLED = JSON.stringify({
  ...DEFAULT_NOTIFICATION_PREFS,
  enabled: true,
  weeklyRecap: false,
  practiceReminderMinutes: 1050,
  promptDismissed: true,
});

describe('NF-1 hydrate swallows a kv read failure into silent defaults', () => {
  it.failing(
    'surfaces the unreadable preferences instead of reporting defaults as truth',
    async () => {
      mockKvTable.set(notificationPrefsKeyForOwner(OWNER), SAVED_ENABLED);
      mockKvReadFails = true;
      await useNotificationStore.getState().hydrate();
      const state = useNotificationStore.getState();
      // Observed: hydrated=true, prefs=DEFAULT (enabled=false), persistFailed=false,
      // scheduleFailed=false and cancelAllPlanned() was called — the user's
      // enabled reminders are wiped from the OS with no copy on any screen.
      expect(state.hydrated).toBe(true);
      expect(
        state.prefs.enabled || state.persistFailed || state.scheduleFailed,
      ).toBe(true);
    },
  );

  it.failing(
    'does not cancel the OS schedule on the strength of unreadable preferences',
    async () => {
      mockKvTable.set(notificationPrefsKeyForOwner(OWNER), SAVED_ENABLED);
      mockKvReadFails = true;
      await useNotificationStore.getState().hydrate();
      expect(mockScheduler.cancelAllPlanned).not.toHaveBeenCalled();
    },
  );

  it.failing(
    'the next healthy save keeps the preferences the read failure hid',
    async () => {
      mockKvTable.set(notificationPrefsKeyForOwner(OWNER), SAVED_ENABLED);
      mockKvReadFails = true;
      await useNotificationStore.getState().hydrate();
      mockKvReadFails = false;
      await useNotificationStore.getState().setPrefs({ comeback: false });
      const stored = parseNotificationPrefs(
        mockKvTable.get(notificationPrefsKeyForOwner(OWNER)) ?? null,
      );
      // Observed: enabled=false, weeklyRecap=true, practiceReminderMinutes=1050→
      // default — the saved preferences are overwritten by defaults + patch.
      expect(stored.enabled).toBe(true);
      expect(stored.weeklyRecap).toBe(false);
    },
  );

  it.failing(
    'a failure reading only the onboarding hand-off key keeps the prefs that were read',
    async () => {
      mockKvTable.set(notificationPrefsKeyForOwner(OWNER), SAVED_ENABLED);
      mockKvReadFailsForKey = PENDING_NOTIFICATION_ONBOARDING_KV_KEY;
      await useNotificationStore.getState().hydrate();
      // The prefs read succeeded; only the second read failed, yet the
      // catch-all discards both.
      expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    },
  );
});

describe('NF-1b hydrate swallows the pending-onboarding write failure', () => {
  it.failing(
    'sets persistFailed when the onboarding hand-off cannot be written',
    async () => {
      mockKvTable.set(
        PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
        JSON.stringify({ version: 1, enabled: true }),
      );
      mockKvWriteFails = true;
      await useNotificationStore.getState().hydrate();
      const state = useNotificationStore.getState();
      // Observed: prefs=DEFAULT (the user's onboarding "enable" answer is
      // dropped), persistFailed=false — nothing on screen says so.
      expect(state.prefs.enabled || state.persistFailed).toBe(true);
    },
  );
});

describe('NF-2 signed-out hydrate reports a failed cancel as success', () => {
  it.failing(
    'sets scheduleFailed when cancelAllPlanned rejects for a signed-out process',
    async () => {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      mockScheduler.cancelAllPlanned.mockRejectedValue(
        new Error('notifee unavailable'),
      );
      await useNotificationStore.getState().hydrate();
      const state = useNotificationStore.getState();
      expect(state.hydrated).toBe(true);
      // Observed: scheduleFailed=false although the OS queue was not cleared.
      expect(state.scheduleFailed).toBe(true);
    },
  );
});

describe('NF-3 NotifeeScheduler maps a malformed authorizationStatus to granted', () => {
  it.failing('undefined authorizationStatus is not granted', async () => {
    mockNotifee.settings = {};
    await expect(
      realService.getScheduler().permissionState(),
    ).resolves.not.toBe('granted');
  });
  it.failing('NaN authorizationStatus is not granted', async () => {
    mockNotifee.settings = { authorizationStatus: Number.NaN };
    await expect(
      realService.getScheduler().requestPermission(),
    ).resolves.not.toBe('granted');
  });
  it.failing(
    'string authorizationStatus "granted" is not granted',
    async () => {
      mockNotifee.settings = { authorizationStatus: 'granted' };
      await expect(
        realService.getScheduler().permissionState(),
      ).resolves.not.toBe('granted');
    },
  );
  it.failing('out-of-range authorizationStatus 7 is not granted', async () => {
    mockNotifee.settings = { authorizationStatus: 7 };
    await expect(
      realService.getScheduler().permissionState(),
    ).resolves.not.toBe('granted');
  });
});

describe('NF-4 foreground PRESS event without detail', () => {
  it.failing('the press listener tolerates an event with no detail', () => {
    const navigate = jest.fn();
    const unsubscribe = realService.subscribeToNotificationPresses(navigate);
    expect(mockNotifee.foregroundListener).not.toBeNull();
    // Observed: TypeError: Cannot read properties of undefined (reading 'notification')
    expect(() => mockNotifee.foregroundListener!({ type: 1 })).not.toThrow();
    expect(navigate).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe('NF-5 never-settling requestPermission leaves controls busy forever', () => {
  const never = () => new Promise<PermissionState>(() => {});

  async function settlesWithin60s(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await jest.advanceTimersByTimeAsync(60_000);
    return settled;
  }

  it.failing(
    'store: completeOnboardingStep(enable) settles within 60 s when the OS prompt never answers',
    async () => {
      // OnboardingScreen.tsx:419-433 holds `notificationBusy` (and therefore
      // the Finish button) on this promise; a hung prompt strands onboarding.
      mockScheduler.requestPermission.mockImplementation(never);
      await useNotificationStore.getState().hydrate();
      const settled = await settlesWithin60s(
        useNotificationStore.getState().completeOnboardingStep('enable'),
      );
      expect(settled).toBe(true);
    },
  );

  it.failing(
    'store: completeOnboardingStep(enable) settles within 60 s when the schedule write never answers',
    async () => {
      mockScheduler.applyPlan.mockImplementation(() => new Promise(() => {}));
      await useNotificationStore.getState().hydrate();
      const settled = await settlesWithin60s(
        useNotificationStore.getState().completeOnboardingStep('enable'),
      );
      expect(settled).toBe(true);
    },
  );

  it.failing(
    'store: requestPermissionAndEnable settles within 60 s when the OS prompt never answers',
    async () => {
      mockScheduler.requestPermission.mockImplementation(never);
      await useNotificationStore.getState().hydrate();
      const settled = await settlesWithin60s(
        useNotificationStore.getState().requestPermissionAndEnable(),
      );
      expect(settled).toBe(true);
    },
  );

  it.failing(
    'priming card: "Not now" is usable again within 60 s',
    async () => {
      mockScheduler.requestPermission.mockImplementation(never);
      await useNotificationStore.getState().hydrate();
      const renderer = await render(<NotificationPrimingCard />);
      await act(async () => {
        pressable(renderer, 'Turn on practice reminders')!.props.onPress();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      // Observed: "Asking…" with both "Turn on" and "Not now" disabled, no
      // timeout anywhere in requestPermissionAndEnable / NotifeeScheduler.
      expect(textContent(renderer)).not.toContain('Asking…');
      expect(pressable(renderer, 'Not now')!.props.disabled).not.toBe(true);
    },
  );

  it.failing(
    'settings: "Turn on reminders" is re-enabled or replaced by recovery copy within 60 s',
    async () => {
      mockScheduler.requestPermission.mockImplementation(never);
      mockScheduler.permissionState.mockResolvedValue('undetermined');
      await useNotificationStore.getState().hydrate();
      const renderer = await render(<NotificationSettingsScreen />);
      await act(async () => {
        pressable(renderer, 'Turn on reminders')!.props.onPress();
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      const button = pressable(renderer, 'Turn on reminders');
      expect(
        button?.props.disabled === true &&
          !textContent(renderer).includes('Try again'),
      ).toBe(false);
    },
  );
});
