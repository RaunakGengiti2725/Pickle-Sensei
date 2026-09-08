import { Linking, Platform } from 'react-native';
import {
  NOTIFICATION_ID_PREFIX,
  type NotificationScreenTarget,
  type PlannedNotification,
} from './types';

/**
 * The one file that talks to the notification native module
 * (react-native-notify-kit, the maintained Notifee fork). Everything above
 * it works against SchedulerPort, so stores and tests never load native
 * code. The import is lazy for the same reason: requiring this module in a
 * Jest environment must not touch TurboModules.
 */

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export interface SchedulerPort {
  permissionState(): Promise<PermissionState>;
  /** Triggers the system prompt (iOS + Android 13+). */
  requestPermission(): Promise<PermissionState>;
  /** Replaces every app-scheduled reminder with exactly `plan`. */
  applyPlan(plan: readonly PlannedNotification[]): Promise<void>;
  /** Cancels every reminder this app has scheduled. */
  cancelAllPlanned(): Promise<void>;
  /** System notification settings for this app (permission recovery path). */
  openSystemSettings(): Promise<void>;
}

const ANDROID_CHANNEL_ID = 'reminders';

type NotifeeModule = typeof import('react-native-notify-kit');

let cachedModule: NotifeeModule | null = null;

function loadModule(): NotifeeModule {
  if (!cachedModule) {
    // Deliberately lazy: the native module must not load at import time
    // (jest hosts and signed-out processes never touch it).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedModule = require('react-native-notify-kit') as NotifeeModule;
  }
  return cachedModule;
}

function toPermissionState(authorizationStatus: number): PermissionState {
  // AuthorizationStatus: NOT_DETERMINED = -1, DENIED = 0, AUTHORIZED = 1,
  // PROVISIONAL = 2. Provisional (quiet) delivery still delivers.
  if (authorizationStatus === -1) return 'undetermined';
  return authorizationStatus === 0 ? 'denied' : 'granted';
}

async function ensureAndroidChannel(module: NotifeeModule): Promise<void> {
  if (Platform.OS !== 'android') return;
  const { AndroidImportance } = module;
  await module.default.createChannel({
    id: ANDROID_CHANNEL_ID,
    name: 'Practice reminders',
    description: 'Practice nudges, streak reminders, and weekly recaps.',
    importance: AndroidImportance.DEFAULT,
  });
}

class NotifeeScheduler implements SchedulerPort {
  async permissionState(): Promise<PermissionState> {
    const module = loadModule();
    const settings = await module.default.getNotificationSettings();
    return toPermissionState(settings.authorizationStatus);
  }

  async requestPermission(): Promise<PermissionState> {
    const module = loadModule();
    const settings = await module.default.requestPermission({
      alert: true,
      badge: true,
      sound: true,
    });
    const state = toPermissionState(settings.authorizationStatus);
    if (state === 'granted') await ensureAndroidChannel(module);
    return state;
  }

  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    const module = loadModule();
    await ensureAndroidChannel(module);
    await this.cancelAllPlanned();
    const { RepeatFrequency, TriggerType } = module;
    for (const item of plan) {
      await module.default.createTriggerNotification(
        {
          id: item.id,
          title: item.title,
          body: item.body,
          data: { screen: item.screen },
          android: {
            channelId: ANDROID_CHANNEL_ID,
            pressAction: { id: 'default' },
          },
        },
        {
          type: TriggerType.TIMESTAMP,
          timestamp: item.timestampMs,
          ...(item.repeat === 'daily'
            ? { repeatFrequency: RepeatFrequency.DAILY }
            : item.repeat === 'weekly'
              ? { repeatFrequency: RepeatFrequency.WEEKLY }
              : {}),
        },
      );
    }
  }

  async cancelAllPlanned(): Promise<void> {
    const module = loadModule();
    const ids = await module.default.getTriggerNotificationIds();
    const owned = ids.filter(id => id.startsWith(NOTIFICATION_ID_PREFIX));
    // Only ids under the app prefix are ever touched.
    for (const id of owned) {
      await module.default.cancelTriggerNotification(id);
    }
  }

  async openSystemSettings(): Promise<void> {
    if (Platform.OS === 'android') {
      const module = loadModule();
      await module.default.openNotificationSettings();
      return;
    }
    await Linking.openSettings();
  }
}

let schedulerInstance: SchedulerPort | null = null;

export function getScheduler(): SchedulerPort {
  if (!schedulerInstance) schedulerInstance = new NotifeeScheduler();
  return schedulerInstance;
}

/** A pressed reminder's declared destination, validated before navigating. */
export function screenTargetFromNotificationData(
  data: unknown,
): NotificationScreenTarget | null {
  if (!data || typeof data !== 'object') return null;
  const screen = (data as Record<string, unknown>)['screen'];
  return screen === 'Home' || screen === 'Performance' ? screen : null;
}

/** Presses held while nothing can navigate yet; the oldest are dropped past this. */
export const MAX_QUEUED_NOTIFICATION_PRESSES = 4;

/**
 * Appends `item` to a bounded FIFO. An equal entry already queued is collapsed
 * into the new (newest) slot, so a replay dispatches each distinct press once.
 */
export function enqueueBounded<T>(
  queue: readonly T[],
  item: T,
  limit: number = MAX_QUEUED_NOTIFICATION_PRESSES,
): T[] {
  const next = queue.filter(queued => queued !== item);
  next.push(item);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

const MAX_ROUTED_PRESS_IDS = 8;

/**
 * Process-wide press intake shared by the foreground listener, the background
 * handler (index.js) and the cold-start read. A press that arrives while no
 * navigator is subscribed waits in `pending`; `routedIds` remembers which
 * notification ids already arrived as PRESS events so the cold-start
 * `getInitialNotification()` read of that same tap is not dispatched twice.
 */
const pressIntake: {
  sink: ((screen: NotificationScreenTarget) => void) | null;
  pending: NotificationScreenTarget[];
  routedIds: string[];
} = { sink: null, pending: [], routedIds: [] };

function deliverPress(target: NotificationScreenTarget): void {
  if (pressIntake.sink) {
    pressIntake.sink(target);
    return;
  }
  pressIntake.pending = enqueueBounded(pressIntake.pending, target);
}

function routePressedNotification(
  notification: { id?: string; data?: unknown } | undefined,
): void {
  if (typeof notification?.id === 'string') {
    pressIntake.routedIds = enqueueBounded(
      pressIntake.routedIds,
      notification.id,
      MAX_ROUTED_PRESS_IDS,
    );
  }
  const target = screenTargetFromNotificationData(notification?.data);
  if (target) deliverPress(target);
}

/**
 * Wires notification press handling: a cold-start press (getInitialNotification)
 * and warm presses (foreground events) both route through `navigate`.
 * Returns the unsubscribe for the foreground listener.
 */
export function subscribeToNotificationPresses(
  navigate: (screen: NotificationScreenTarget) => void,
): () => void {
  const module = loadModule();
  const { EventType } = module;
  pressIntake.sink = navigate;
  const waiting = pressIntake.pending;
  pressIntake.pending = [];
  for (const target of waiting) navigate(target);
  void module.default
    .getInitialNotification()
    .then(initial => {
      if (!initial) return;
      const { id } = initial.notification;
      if (typeof id === 'string' && pressIntake.routedIds.includes(id)) return;
      const target = screenTargetFromNotificationData(
        initial.notification.data,
      );
      if (target) deliverPress(target);
    })
    .catch(() => {
      // A failed initial-notification read only costs the deep link.
    });
  const unsubscribe = module.default.onForegroundEvent(event => {
    if (event.type !== EventType.PRESS) return;
    routePressedNotification(event.detail.notification);
  });
  return () => {
    if (pressIntake.sink === navigate) pressIntake.sink = null;
    unsubscribe();
  };
}

/**
 * Registered from index.js. Notifee requires a background handler; reminders
 * need no background work, so this only acknowledges the event.
 */
export function registerBackgroundNotificationHandler(): void {
  const module = loadModule();
  const { EventType } = module;
  // iOS hands a tap made while the app is inactive or suspended (a warm start
  // from a reminder) to this channel, not to the foreground listener.
  module.default.onBackgroundEvent(async event => {
    if (event.type === EventType.PRESS) {
      routePressedNotification(event.detail.notification);
      return;
    }
    // Local reminders carry no background side effects.
  });
}
