/**
 * Local engagement reminders. Everything is scheduled ON THIS PHONE with the
 * system notification center — no push service, no server, and nothing about
 * the player's play ever leaves the device to produce a reminder.
 *
 * Honesty rules, same as the rest of the app:
 *   - OFF by default; nothing is scheduled until the player turns it on.
 *   - Copy never invents facts (no fake "you lost your streak" pressure).
 *   - Content carries no personal data — it is visible on a lock screen.
 */

export type NotificationScreenTarget = 'Home' | 'Performance';

export const PLANNED_NOTIFICATION_IDS = [
  'ps.reminder.practice',
  'ps.reminder.streak',
  'ps.reminder.weekly',
  'ps.comeback.1',
  'ps.comeback.2',
  'ps.comeback.3',
] as const;

export type PlannedNotificationId = (typeof PLANNED_NOTIFICATION_IDS)[number];

/** Every id this app may schedule starts with this prefix; cancellation only
 * ever touches ids under it, never anything else in the tray. */
export const NOTIFICATION_ID_PREFIX = 'ps.';

export interface PlannedNotification {
  id: PlannedNotificationId;
  title: string;
  body: string;
  /** Absolute delivery time, ms since epoch, strictly in the future. */
  timestampMs: number;
  repeat: 'daily' | 'weekly' | null;
  screen: NotificationScreenTarget;
}

export interface NotificationPrefs {
  version: 1;
  /** Master switch; false cancels everything scheduled by the app. */
  enabled: boolean;
  /** Daily practice nudge at `practiceReminderMinutes` past local midnight. */
  practiceReminder: boolean;
  practiceReminderMinutes: number;
  /** Evening one-shot when an active streak has no capture yet that day. */
  streakDefense: boolean;
  /** Sunday-evening pointer to the Progress tab. */
  weeklyRecap: boolean;
  /** Re-engagement one-shots at 3/7/14 days of not opening the app. */
  comeback: boolean;
  /** Home-screen priming card: dismissed forever once answered. */
  promptDismissed: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  version: 1,
  enabled: false,
  practiceReminder: true,
  practiceReminderMinutes: 17 * 60 + 30,
  streakDefense: true,
  weeklyRecap: true,
  comeback: true,
  promptDismissed: false,
};

const MINUTES_IN_DAY = 24 * 60;

/** Parses a stored prefs JSON string defensively: any malformed field falls
 * back to its default, and unknown payloads fall back entirely. */
export function parseNotificationPrefs(raw: string | null): NotificationPrefs {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
  const record = parsed as Record<string, unknown>;
  const bool = (key: keyof NotificationPrefs): boolean => {
    const value = record[key];
    return typeof value === 'boolean'
      ? value
      : (DEFAULT_NOTIFICATION_PREFS[key] as boolean);
  };
  const minutes = record['practiceReminderMinutes'];
  const practiceReminderMinutes =
    typeof minutes === 'number' &&
    Number.isInteger(minutes) &&
    minutes >= 0 &&
    minutes < MINUTES_IN_DAY
      ? minutes
      : DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes;
  return {
    version: 1,
    enabled: bool('enabled'),
    practiceReminder: bool('practiceReminder'),
    practiceReminderMinutes,
    streakDefense: bool('streakDefense'),
    weeklyRecap: bool('weeklyRecap'),
    comeback: bool('comeback'),
    promptDismissed: bool('promptDismissed'),
  };
}

export function notificationPrefsKeyForOwner(owner: string): string {
  return `notifications:${owner}`;
}

/** "5:30 PM" for a minutes-past-midnight value, without date libraries. */
export function formatReminderMinutes(minutesPastMidnight: number): string {
  const clamped =
    ((Math.round(minutesPastMidnight) % MINUTES_IN_DAY) + MINUTES_IN_DAY) %
    MINUTES_IN_DAY;
  const hour24 = Math.floor(clamped / 60);
  const minute = clamped % 60;
  const meridiem = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}
