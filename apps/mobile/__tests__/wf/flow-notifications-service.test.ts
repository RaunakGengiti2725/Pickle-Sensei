import { Linking, Platform } from 'react-native';
import notifee from 'react-native-notify-kit';
import {
  getScheduler,
  screenTargetFromNotificationData,
  subscribeToNotificationPresses,
} from '../../src/notifications/service';
import type {
  PlannedNotification,
  PlannedNotificationId,
} from '../../src/notifications/types';

/**
 * The native adapter behind SchedulerPort, exercised against the repo's
 * react-native-notify-kit auto-mock: permission mapping (incl. provisional),
 * prefix-only cancellation (foreign trigger ids are never touched), plan
 * replacement, the iOS "Open system settings" deep link, and validated press
 * routing so a reminder can only ever land on Home or Performance.
 */

const mocked = notifee as unknown as {
  requestPermission: jest.Mock;
  getNotificationSettings: jest.Mock;
  createTriggerNotification: jest.Mock;
  getTriggerNotificationIds: jest.Mock;
  cancelTriggerNotification: jest.Mock;
  openNotificationSettings: jest.Mock;
  getInitialNotification: jest.Mock;
  onForegroundEvent: jest.Mock;
};

const item = (
  id: PlannedNotificationId,
  screen: 'Home' | 'Performance',
): PlannedNotification => ({
  id,
  title: 'Court time.',
  body: 'One scored read keeps the plan honest.',
  timestampMs: Date.now() + 3_600_000,
  repeat: id.endsWith('practice') ? 'daily' : null,
  screen,
});

beforeEach(() => {
  mocked.requestPermission.mockClear();
  mocked.getNotificationSettings.mockClear();
  mocked.createTriggerNotification.mockClear();
  mocked.cancelTriggerNotification.mockClear();
  mocked.openNotificationSettings.mockClear();
  mocked.getInitialNotification.mockClear();
  mocked.onForegroundEvent.mockClear();
  mocked.getTriggerNotificationIds.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('permission mapping', () => {
  it.each([
    [-1, 'undetermined'],
    [0, 'denied'],
    [1, 'granted'],
    [2, 'granted'],
  ])('authorizationStatus %i → %s', async (status, expected) => {
    mocked.getNotificationSettings.mockResolvedValueOnce({
      authorizationStatus: status,
    });
    await expect(getScheduler().permissionState()).resolves.toBe(expected);
    mocked.requestPermission.mockResolvedValueOnce({
      authorizationStatus: status,
    });
    await expect(getScheduler().requestPermission()).resolves.toBe(expected);
  });

  it('requestPermission asks for alert + sound + badge', async () => {
    mocked.requestPermission.mockResolvedValueOnce({ authorizationStatus: 1 });
    await getScheduler().requestPermission();
    expect(mocked.requestPermission).toHaveBeenCalledWith({
      alert: true,
      badge: true,
      sound: true,
    });
  });
});

describe('cancellation + plan replacement', () => {
  it('cancelAllPlanned only removes ids under the `ps.` prefix', async () => {
    mocked.getTriggerNotificationIds.mockResolvedValueOnce([
      'ps.reminder.practice',
      'other-app-or-os.id',
      'ps.comeback.2',
      'psx.not-ours',
    ]);
    await getScheduler().cancelAllPlanned();
    expect(mocked.cancelTriggerNotification.mock.calls.map(c => c[0])).toEqual([
      'ps.reminder.practice',
      'ps.comeback.2',
    ]);
  });

  it('applyPlan replaces everything owned and creates exactly the plan, with the tab target in data', async () => {
    mocked.getTriggerNotificationIds.mockResolvedValueOnce([
      'ps.reminder.streak',
      'foreign.id',
    ]);
    const practicePlan = item('ps.reminder.practice', 'Home');
    const plan = [practicePlan, item('ps.reminder.weekly', 'Performance')];
    await getScheduler().applyPlan(plan);
    expect(mocked.cancelTriggerNotification.mock.calls.map(c => c[0])).toEqual([
      'ps.reminder.streak',
    ]);
    expect(mocked.createTriggerNotification).toHaveBeenCalledTimes(2);
    const [practice, weekly] = mocked.createTriggerNotification.mock.calls;
    expect(practice[0]).toMatchObject({
      id: 'ps.reminder.practice',
      data: { screen: 'Home' },
    });
    expect(practice[1]).toMatchObject({
      timestamp: practicePlan.timestampMs,
      repeatFrequency: 1,
    });
    expect(weekly[0]).toMatchObject({
      id: 'ps.reminder.weekly',
      data: { screen: 'Performance' },
    });
    expect(weekly[1]).not.toHaveProperty('repeatFrequency');
  });

  it('an empty plan just clears owned reminders', async () => {
    mocked.getTriggerNotificationIds.mockResolvedValueOnce([
      'ps.comeback.1',
      'ps.comeback.3',
    ]);
    await getScheduler().applyPlan([]);
    expect(mocked.cancelTriggerNotification).toHaveBeenCalledTimes(2);
    expect(mocked.createTriggerNotification).not.toHaveBeenCalled();
  });
});

describe('open system settings', () => {
  it('iOS → Linking.openSettings (the app’s own notification page)', async () => {
    const openSettings = jest
      .spyOn(Linking, 'openSettings')
      .mockResolvedValue(undefined);
    expect(Platform.OS).toBe('ios');
    await getScheduler().openSystemSettings();
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(mocked.openNotificationSettings).not.toHaveBeenCalled();
  });
});

describe('press routing', () => {
  it('only Home / Performance are accepted as targets', () => {
    expect(screenTargetFromNotificationData({ screen: 'Home' })).toBe('Home');
    expect(screenTargetFromNotificationData({ screen: 'Performance' })).toBe(
      'Performance',
    );
    expect(
      screenTargetFromNotificationData({ screen: 'LiveCourt' }),
    ).toBeNull();
    expect(screenTargetFromNotificationData({ screen: 'Paywall' })).toBeNull();
    expect(screenTargetFromNotificationData(undefined)).toBeNull();
    expect(screenTargetFromNotificationData('Home')).toBeNull();
    expect(screenTargetFromNotificationData({})).toBeNull();
  });

  it('cold-start and foreground presses navigate; non-press events and bad data are ignored', async () => {
    mocked.getInitialNotification.mockResolvedValueOnce({
      notification: { data: { screen: 'Performance' } },
    });
    let foregroundHandler: ((event: unknown) => void) | null = null;
    const unsubscribe = jest.fn();
    mocked.onForegroundEvent.mockImplementationOnce(
      (handler: (event: unknown) => void) => {
        foregroundHandler = handler;
        return unsubscribe;
      },
    );
    const navigate = jest.fn();
    const off = subscribeToNotificationPresses(navigate);
    await Promise.resolve();
    await Promise.resolve();
    expect(navigate).toHaveBeenCalledWith('Performance');

    expect(foregroundHandler).not.toBeNull();
    foregroundHandler!({
      type: 0,
      detail: { notification: { data: { screen: 'Home' } } },
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    foregroundHandler!({
      type: 1,
      detail: { notification: { data: { screen: 'Nope' } } },
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    foregroundHandler!({
      type: 1,
      detail: { notification: { data: { screen: 'Home' } } },
    });
    expect(navigate).toHaveBeenCalledWith('Home');
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a failing cold-start read only costs the deep link', async () => {
    mocked.getInitialNotification.mockRejectedValueOnce(new Error('nope'));
    mocked.onForegroundEvent.mockImplementationOnce(() => () => {});
    const navigate = jest.fn();
    expect(() => subscribeToNotificationPresses(navigate)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(navigate).not.toHaveBeenCalled();
  });
});
