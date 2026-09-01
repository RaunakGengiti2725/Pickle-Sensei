/**
 * Jest auto-mock for the notification native module. Tests exercise
 * notification logic through the SchedulerPort seam with their own fakes;
 * this mock only keeps any transitive import of the real package from
 * touching TurboModules inside the test environment.
 */

type StoredTrigger = { notification: { id?: string }; trigger: unknown };

const triggers: StoredTrigger[] = [];

const notifee = {
  requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
  getNotificationSettings: jest.fn(async () => ({ authorizationStatus: 1 })),
  createChannel: jest.fn(async () => 'reminders'),
  createTriggerNotification: jest.fn(
    async (notification: { id?: string }, trigger: unknown) => {
      triggers.push({ notification, trigger });
      return notification.id ?? 'mock-id';
    },
  ),
  getTriggerNotificationIds: jest.fn(async () =>
    triggers.map(entry => entry.notification.id ?? 'mock-id'),
  ),
  cancelTriggerNotification: jest.fn(async (id: string) => {
    const index = triggers.findIndex(entry => entry.notification.id === id);
    if (index >= 0) triggers.splice(index, 1);
  }),
  openNotificationSettings: jest.fn(async () => {}),
  getInitialNotification: jest.fn(async () => null),
  onForegroundEvent: jest.fn(() => () => {}),
  onBackgroundEvent: jest.fn(),
};

export const AndroidImportance = { DEFAULT: 3, HIGH: 4 } as const;
export const RepeatFrequency = {
  NONE: -1,
  HOURLY: 0,
  DAILY: 1,
  WEEKLY: 2,
} as const;
export const TriggerType = { TIMESTAMP: 0, INTERVAL: 1 } as const;
export const EventType = { DISMISSED: 0, PRESS: 1, DELIVERED: 3 } as const;

export default notifee;
