import React from 'react';
import { Linking, Switch, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockSetKv = jest.fn<Promise<void>, [unknown, string, string]>(
  async () => {},
);
const mockGetKv = jest.fn<Promise<string | null>, [unknown, string]>(
  async () => null,
);
jest.mock('../../src/data/repository', () => ({
  getKv: (...args: [unknown, string]) => mockGetKv(...args),
  setKv: (...args: [unknown, string, string]) => mockSetKv(...args),
}));

jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: jest.fn(async () => ({
    currentStreak: 0,
    trainedToday: false,
    totalActivities: 0,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
const mockFocusEffects: Array<() => void | (() => void)> = [];
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => {
      mockFocusEffects.push(callback);
      return callback();
    }, [callback]);
  },
}));

const mockScheduler = {
  permissionState: jest.fn<Promise<PermissionState>, []>(async () => 'granted'),
  requestPermission: jest.fn<Promise<PermissionState>, []>(
    async () => 'granted',
  ),
  applyPlan: jest.fn<Promise<void>, [readonly unknown[]]>(async () => {}),
  cancelAllPlanned: jest.fn<Promise<void>, []>(async () => {}),
  openSystemSettings: jest.fn<Promise<void>, []>(async () => {}),
};
const mockGetScheduler = jest.fn(() => mockScheduler);
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockGetScheduler(),
}));

import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import type { PermissionState } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  type NotificationPrefs,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * Button ledger for NotificationSettingsScreen: every pressable on the screen
 * is pressed here and traced to its real effect through the real
 * notificationStore (prefs persisted to the owner-scoped kv, schedule
 * re-applied through the SchedulerPort, permission recovery path opened).
 *
 * Pressables:
 *   Back (ScreenHeader)              -> navigation.goBack()
 *   Open system settings (Button)    -> getScheduler().openSystemSettings()
 *   Turn on reminders (Button)       -> requestPermissionAndEnable()
 *   All reminders (Switch)           -> setPrefs({ enabled })
 *   Practice nudge (Switch)          -> setPrefs({ practiceReminder })
 *   Morning/Midday/Evening/Night     -> setPrefs({ practiceReminderMinutes })
 *   Reminder 30 minutes earlier      -> stepReminderTime(-1)
 *   Reminder 30 minutes later        -> stepReminderTime(1)
 *   Streak defense (Switch)          -> setPrefs({ streakDefense })
 *   Weekly recap (Switch)            -> setPrefs({ weeklyRecap })
 *   Welcome back (Switch)            -> setPrefs({ comeback })
 */

const ENABLED_PREFS: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  enabled: true,
  promptDismissed: true,
};

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<NotificationSettingsScreen />);
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function findPressables(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = findPressables(renderer, label);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function pressableAbsent(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
) {
  expect(findPressables(renderer, label)).toHaveLength(0);
}

function switchFor(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Switch)
    .filter(node => node.props.accessibilityLabel === label);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = pressable(renderer, label);
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onPress();
  });
  await flush();
}

async function toggle(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
  next: boolean,
) {
  const node = switchFor(renderer, label);
  expect(node.props.disabled).not.toBe(true);
  await act(async () => {
    node.props.onValueChange(next);
  });
  await flush();
}

function lastPersistedPrefs(): NotificationPrefs {
  const call = mockSetKv.mock.calls.at(-1);
  expect(call).toBeDefined();
  expect(call![1]).toBe(notificationPrefsKeyForOwner(GUEST_DATA_OWNER));
  return JSON.parse(call![2]) as NotificationPrefs;
}

function seedStore(
  prefs: NotificationPrefs,
  permission: PermissionState | 'unknown',
) {
  useNotificationStore.setState({
    hydrated: true,
    ownerKey: GUEST_DATA_OWNER,
    prefs,
    permission,
  });
  mockScheduler.permissionState.mockResolvedValue(
    permission === 'unknown' ? 'granted' : permission,
  );
}

describe('NotificationSettingsScreen buttons', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFocusEffects.length = 0;
    mockGetScheduler.mockImplementation(() => mockScheduler);
    mockScheduler.permissionState.mockImplementation(async () => 'granted');
    mockScheduler.requestPermission.mockImplementation(async () => 'granted');
    mockScheduler.applyPlan.mockImplementation(async () => {});
    mockScheduler.cancelAllPlanned.mockImplementation(async () => {});
    mockScheduler.openSystemSettings.mockImplementation(async () => {});
    mockSetKv.mockImplementation(async () => {});
    setActiveDataOwner(GUEST_DATA_OWNER);
    seedStore({ ...DEFAULT_NOTIFICATION_PREFS }, 'undetermined');
  });

  describe('header', () => {
    it('Back -> navigation.goBack()', async () => {
      const renderer = renderScreen();
      await press(renderer, 'Back');
      expect(mockGoBack).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('re-reads the system permission on focus so the recovery banner is never stale', async () => {
      mockScheduler.permissionState.mockResolvedValue('denied');
      const renderer = renderScreen();
      await flush();
      expect(mockScheduler.permissionState).toHaveBeenCalled();
      expect(useNotificationStore.getState().permission).toBe('denied');
      expect(allText(renderer)).toContain(
        'Notifications are off in system settings',
      );
      expect(mockFocusEffects.length).toBeGreaterThan(0);
      act(() => renderer.unmount());
    });
  });

  describe('Turn on reminders', () => {
    it('is only offered while reminders are off', () => {
      const renderer = renderScreen();
      pressable(renderer, 'Turn on reminders');
      pressableAbsent(renderer, 'Open system settings');
      expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
      act(() => renderer.unmount());
    });

    it('granted -> master switch on, prefs persisted, schedule applied, card replaced by controls', async () => {
      const renderer = renderScreen();
      await press(renderer, 'Turn on reminders');

      expect(mockScheduler.requestPermission).toHaveBeenCalledTimes(1);
      const state = useNotificationStore.getState();
      expect(state.permission).toBe('granted');
      expect(state.prefs.enabled).toBe(true);
      expect(state.prefs.promptDismissed).toBe(true);
      expect(lastPersistedPrefs()).toMatchObject({
        enabled: true,
        promptDismissed: true,
      });
      expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(1);

      pressableAbsent(renderer, 'Turn on reminders');
      expect(switchFor(renderer, 'All reminders').props.value).toBe(true);
      expect(allText(renderer)).toContain(
        'Scheduled from your real practice history',
      );
      act(() => renderer.unmount());
    });

    it('denied by the OS -> nothing is enabled and the recovery banner appears', async () => {
      mockScheduler.requestPermission.mockResolvedValue('denied');
      const renderer = renderScreen();
      await press(renderer, 'Turn on reminders');

      expect(useNotificationStore.getState().prefs.enabled).toBe(false);
      expect(mockSetKv).not.toHaveBeenCalled();
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
      expect(allText(renderer)).toContain(
        'Notifications are off in system settings',
      );
      pressable(renderer, 'Open system settings');
      act(() => renderer.unmount());
    });

    it('permission request rejecting -> no crash, button stays usable', async () => {
      mockScheduler.requestPermission.mockRejectedValue(
        new Error('native module unavailable'),
      );
      const renderer = renderScreen();
      await press(renderer, 'Turn on reminders');

      expect(useNotificationStore.getState().prefs.enabled).toBe(false);
      expect(useNotificationStore.getState().permission).toBe('unknown');
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
      const button = pressable(renderer, 'Turn on reminders');
      expect(button.props.disabled).not.toBe(true);
      // WF-ISSUE: Turn on reminders shows no feedback when the permission request fails
      // (the failure is swallowed in requestPermissionAndEnable; no copy tells
      // the player the tap did nothing).
      act(() => renderer.unmount());
    });

    it('while the OS permission is denied the button is still rendered but cannot enable anything', async () => {
      seedStore({ ...DEFAULT_NOTIFICATION_PREFS }, 'denied');
      mockScheduler.requestPermission.mockResolvedValue('denied');
      const renderer = renderScreen();
      await flush();

      const before = allText(renderer);
      await press(renderer, 'Turn on reminders');
      expect(mockScheduler.requestPermission).toHaveBeenCalledTimes(1);
      expect(useNotificationStore.getState().prefs.enabled).toBe(false);
      expect(mockSetKv).not.toHaveBeenCalled();
      expect(allText(renderer)).toBe(before);
      // WF-ISSUE: Turn on reminders is a dead control while the OS permission is denied
      // (iOS never re-prompts after a denial; the tap changes nothing on screen
      // while the recovery path is the "Open system settings" button above).
      act(() => renderer.unmount());
    });
  });

  describe('Open system settings', () => {
    it('is only offered while the OS permission is denied', () => {
      seedStore(ENABLED_PREFS, 'granted');
      const renderer = renderScreen();
      pressableAbsent(renderer, 'Open system settings');
      act(() => renderer.unmount());
    });

    it('-> getScheduler().openSystemSettings()', async () => {
      seedStore(ENABLED_PREFS, 'denied');
      const renderer = renderScreen();
      await flush();
      expect(allText(renderer)).toContain(
        'Paused until notifications are allowed',
      );
      await press(renderer, 'Open system settings');
      expect(mockScheduler.openSystemSettings).toHaveBeenCalledTimes(1);
      act(() => renderer.unmount());
    });

    it('reaches Linking.openSettings through the real iOS scheduler', async () => {
      seedStore(ENABLED_PREFS, 'denied');
      const actual = jest.requireActual<
        typeof import('../../src/notifications/service')
      >('../../src/notifications/service');
      const openSettings = jest
        .spyOn(Linking, 'openSettings')
        .mockResolvedValue(undefined);
      const renderer = renderScreen();
      await flush();
      mockGetScheduler.mockImplementation(
        () => actual.getScheduler() as unknown as typeof mockScheduler,
      );
      await press(renderer, 'Open system settings');
      expect(openSettings).toHaveBeenCalledTimes(1);
      openSettings.mockRestore();
      act(() => renderer.unmount());
    });

    it('a failing settings deep link leaves the button usable', async () => {
      seedStore(ENABLED_PREFS, 'denied');
      // The screen discards the promise (`void ...openSystemSettings()`), so a
      // bare rejection would surface as an unhandled rejection and fail the
      // run; the fake pre-attaches a handler to the SAME promise so the test
      // can observe what the screen does (nothing) without that noise.
      mockScheduler.openSystemSettings.mockImplementation(() => {
        const failure = Promise.reject(new Error('cannot open'));
        failure.catch(() => {});
        return failure;
      });
      const renderer = renderScreen();
      await flush();
      const before = allText(renderer);
      await press(renderer, 'Open system settings');
      expect(mockScheduler.openSystemSettings).toHaveBeenCalledTimes(1);
      expect(
        pressable(renderer, 'Open system settings').props.disabled,
      ).not.toBe(true);
      expect(allText(renderer)).toBe(before);
      // WF-ISSUE: Open system settings swallows a failed deep link as an unhandled rejection
      // (no catch, no copy; the player sees nothing happen).
      act(() => renderer.unmount());
    });
  });

  describe('reminder switches', () => {
    beforeEach(() => {
      seedStore(ENABLED_PREFS, 'granted');
    });

    it('All reminders off -> enabled:false persisted, everything cancelled, enable card returns', async () => {
      const renderer = renderScreen();
      await flush();
      await toggle(renderer, 'All reminders', false);

      expect(useNotificationStore.getState().prefs.enabled).toBe(false);
      expect(lastPersistedPrefs().enabled).toBe(false);
      expect(mockScheduler.cancelAllPlanned).toHaveBeenCalled();
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
      pressable(renderer, 'Turn on reminders');
      expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
      act(() => renderer.unmount());
    });

    it.each([
      ['Practice nudge', 'practiceReminder'],
      ['Streak defense', 'streakDefense'],
      ['Weekly recap', 'weeklyRecap'],
      ['Welcome back', 'comeback'],
    ] as const)(
      '%s -> setPrefs({ %s }) persisted and schedule re-applied',
      async (label, key) => {
        const renderer = renderScreen();
        await flush();
        expect(switchFor(renderer, label).props.value).toBe(true);

        await toggle(renderer, label, false);
        expect(useNotificationStore.getState().prefs[key]).toBe(false);
        expect(lastPersistedPrefs()[key]).toBe(false);
        expect(switchFor(renderer, label).props.value).toBe(false);
        expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(1);

        await toggle(renderer, label, true);
        expect(useNotificationStore.getState().prefs[key]).toBe(true);
        expect(lastPersistedPrefs()[key]).toBe(true);
        expect(switchFor(renderer, label).props.value).toBe(true);
        expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(2);
        act(() => renderer.unmount());
      },
    );

    it('every switch is labelled and not disabled while reminders are on', async () => {
      const renderer = renderScreen();
      await flush();
      const switches = renderer.root.findAllByType(Switch);
      expect(switches.map(s => s.props.accessibilityLabel)).toEqual([
        'All reminders',
        'Practice nudge',
        'Streak defense',
        'Weekly recap',
        'Welcome back',
      ]);
      for (const node of switches) {
        expect(node.props.disabled).toBeFalsy();
        expect(typeof node.props.onValueChange).toBe('function');
      }
      act(() => renderer.unmount());
    });

    it('a failing kv write keeps the chosen value on screen and still re-syncs the schedule', async () => {
      mockSetKv.mockRejectedValue(new Error('disk full'));
      const renderer = renderScreen();
      await flush();
      await toggle(renderer, 'Streak defense', false);

      expect(useNotificationStore.getState().prefs.streakDefense).toBe(false);
      expect(switchFor(renderer, 'Streak defense').props.value).toBe(false);
      expect(switchFor(renderer, 'Streak defense').props.disabled).toBeFalsy();
      expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(1);
      // WF-ISSUE: reminder preference changes report nothing when the durable save fails
      // (the switch shows the new value although it will revert on next launch).
      act(() => renderer.unmount());
    });

    it('a failing schedule apply never surfaces as a crash', async () => {
      mockScheduler.applyPlan.mockRejectedValue(new Error('notifee down'));
      const renderer = renderScreen();
      await flush();
      await toggle(renderer, 'Weekly recap', false);
      expect(switchFor(renderer, 'Weekly recap').props.value).toBe(false);
      expect(lastPersistedPrefs().weeklyRecap).toBe(false);
      act(() => renderer.unmount());
    });
  });

  describe('reminder time', () => {
    beforeEach(() => {
      seedStore(ENABLED_PREFS, 'granted');
    });

    const presets = [
      ['Morning, 7:30 AM', 7 * 60 + 30],
      ['Midday, 12:00 PM', 12 * 60],
      ['Evening, 5:30 PM', 17 * 60 + 30],
      ['Night, 7:30 PM', 19 * 60 + 30],
    ] as const;

    it.each(presets)(
      '%s preset -> practiceReminderMinutes %i persisted and selected',
      async (label, minutes) => {
        const renderer = renderScreen();
        await flush();
        await press(renderer, label);

        expect(
          useNotificationStore.getState().prefs.practiceReminderMinutes,
        ).toBe(minutes);
        expect(lastPersistedPrefs().practiceReminderMinutes).toBe(minutes);
        expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(1);
        expect(
          pressable(renderer, label).props.accessibilityState,
        ).toMatchObject({ selected: true });
        for (const [other] of presets) {
          if (other === label) continue;
          expect(
            pressable(renderer, other).props.accessibilityState,
          ).toMatchObject({ selected: false });
        }
        act(() => renderer.unmount());
      },
    );

    it('-30m / +30m step the time and persist each step', async () => {
      const renderer = renderScreen();
      await flush();
      expect(allText(renderer)).toContain('5:30 PM');

      await press(renderer, 'Reminder 30 minutes earlier');
      expect(
        useNotificationStore.getState().prefs.practiceReminderMinutes,
      ).toBe(17 * 60);
      expect(lastPersistedPrefs().practiceReminderMinutes).toBe(17 * 60);
      expect(allText(renderer)).toContain('5:00 PM');

      await press(renderer, 'Reminder 30 minutes later');
      await press(renderer, 'Reminder 30 minutes later');
      expect(
        useNotificationStore.getState().prefs.practiceReminderMinutes,
      ).toBe(18 * 60);
      expect(allText(renderer)).toContain('6:00 PM');
      expect(mockScheduler.applyPlan).toHaveBeenCalledTimes(3);
      act(() => renderer.unmount());
    });

    it('stepping wraps around midnight in both directions', async () => {
      seedStore({ ...ENABLED_PREFS, practiceReminderMinutes: 0 }, 'granted');
      const renderer = renderScreen();
      await flush();

      await press(renderer, 'Reminder 30 minutes earlier');
      expect(
        useNotificationStore.getState().prefs.practiceReminderMinutes,
      ).toBe(23 * 60 + 30);
      expect(allText(renderer)).toContain('11:30 PM');

      await press(renderer, 'Reminder 30 minutes later');
      expect(
        useNotificationStore.getState().prefs.practiceReminderMinutes,
      ).toBe(0);
      expect(allText(renderer)).toContain('12:00 AM');
      act(() => renderer.unmount());
    });

    it('presets and stepper are disabled while the practice nudge is off', async () => {
      seedStore({ ...ENABLED_PREFS, practiceReminder: false }, 'granted');
      const renderer = renderScreen();
      await flush();

      const labels = [
        ...presets.map(([label]) => label),
        'Reminder 30 minutes earlier',
        'Reminder 30 minutes later',
      ];
      for (const label of labels) {
        const nodes = findPressables(renderer, label);
        expect(nodes[0]!.props.disabled).toBe(true);
        expect(
          nodes.some(
            node =>
              (
                node.props.accessibilityState as
                  { disabled?: boolean } | undefined
              )?.disabled === true,
          ),
        ).toBe(true);
      }

      await toggle(renderer, 'Practice nudge', true);
      for (const label of labels) {
        expect(pressable(renderer, label).props.disabled).toBe(false);
      }
      act(() => renderer.unmount());
    });

    it('every pressable exposes accessibilityRole="button"', async () => {
      const renderer = renderScreen();
      await flush();
      const labels = [
        ...presets.map(([label]) => label),
        'Reminder 30 minutes earlier',
        'Reminder 30 minutes later',
        'Back',
      ];
      for (const label of labels) {
        const nodes = findPressables(renderer, label);
        const roles = nodes.map(node => node.props.accessibilityRole);
        expect(roles).toContain('button');
      }
      act(() => renderer.unmount());
    });
  });

  describe('signed-out safety', () => {
    it('never persists or schedules for a signed-out process', async () => {
      const { SIGNED_OUT_DATA_OWNER } = jest.requireActual<
        typeof import('../../src/data/accountScope')
      >('../../src/data/accountScope');
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      seedStore(ENABLED_PREFS, 'granted');
      const renderer = renderScreen();
      await flush();
      await toggle(renderer, 'Weekly recap', false);
      expect(mockSetKv).not.toHaveBeenCalled();
      expect(mockScheduler.applyPlan).not.toHaveBeenCalled();
      expect(useNotificationStore.getState().prefs.weeklyRecap).toBe(true);
      act(() => renderer.unmount());
    });
  });
});
