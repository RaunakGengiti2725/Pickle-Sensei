import {
  COMEBACK_COPY,
  practiceReminderCopy,
  streakDefenseCopy,
  weeklyRecapCopy,
} from './copy';
import type { NotificationPrefs, PlannedNotification } from './types';

/**
 * Pure reminder planning. Given the player's preferences and the honest
 * facts of the moment (streak, whether today already has a capture), this
 * produces the exact set of notifications that should exist on the device.
 *
 * The scheduler applies a plan by replacing everything under the app's id
 * prefix, so planning is idempotent: syncing twice is the same as once, and
 * every re-open of the app re-arms the inactivity ladder (which is what
 * keeps "come back" notifications from ever firing for an active player).
 *
 * All math is LOCAL time — reminders belong to the player's clock.
 */

export interface NotificationPlanContext {
  nowMs: number;
  /** Current TRAINING streak in days — meaningful training days from the
   * consistency engine (analyses, sessions, drills), never app opens. */
  streakDays: number;
  /** True when today already counts as a trained day. */
  practicedToday: boolean;
  /** True when the player has any training history at all. */
  hasAnyHistory: boolean;
  /** Banked Streak Shields; lets the defense copy be honest about safety. */
  shieldsAvailable?: number;
  /** Set when completing the next trained day reaches a streak milestone. */
  milestoneEve?: { title: string; days: number } | null;
}

/** Never schedule anything closer than this; a sync must not self-fire. */
const MIN_LEAD_MS = 90_000;

const STREAK_DEFENSE_MINUTES = 19 * 60 + 30;
const WEEKLY_RECAP_MINUTES = 18 * 60;
const COMEBACK_MINUTES = 18 * 60 + 30;
/** Sunday in JS Date#getDay() terms. */
const WEEKLY_RECAP_WEEKDAY = 0;
const COMEBACK_RUNG_DAYS = [3, 7, 14] as const;

/** The wall-clock `minutesPastMidnight` on the local calendar day of
 * `baseMs`. Set as hours/minutes on that day — never midnight plus an
 * offset, which lands an hour off on a 23h/25h DST transition day. */
function atLocalMinutes(baseMs: number, minutesPastMidnight: number): number {
  const date = new Date(baseMs);
  date.setHours(
    Math.floor(minutesPastMidnight / 60),
    minutesPastMidnight % 60,
    0,
    0,
  );
  return date.getTime();
}

function addDays(baseMs: number, days: number): number {
  const date = new Date(baseMs);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/** Today at `minutes` if comfortably in the future, otherwise tomorrow. */
function nextDailyOccurrence(nowMs: number, minutes: number): number {
  const today = atLocalMinutes(nowMs, minutes);
  return today >= nowMs + MIN_LEAD_MS
    ? today
    : atLocalMinutes(addDays(nowMs, 1), minutes);
}

function nextWeeklyOccurrence(
  nowMs: number,
  weekday: number,
  minutes: number,
): number {
  const todayWeekday = new Date(nowMs).getDay();
  const daysAhead = (weekday - todayWeekday + 7) % 7;
  const candidate = atLocalMinutes(addDays(nowMs, daysAhead), minutes);
  return candidate >= nowMs + MIN_LEAD_MS
    ? candidate
    : atLocalMinutes(addDays(nowMs, daysAhead + 7), minutes);
}

export function buildNotificationPlan(
  prefs: NotificationPrefs,
  context: NotificationPlanContext,
): PlannedNotification[] {
  if (!prefs.enabled) return [];
  const plan: PlannedNotification[] = [];

  if (prefs.practiceReminder) {
    const timestampMs = nextDailyOccurrence(
      context.nowMs,
      prefs.practiceReminderMinutes,
    );
    const copy = practiceReminderCopy(timestampMs);
    plan.push({
      id: 'ps.reminder.practice',
      title: copy.title,
      body: copy.body,
      timestampMs,
      repeat: 'daily',
      screen: 'Home',
    });
  }

  if (prefs.streakDefense && context.streakDays > 0) {
    // One-shot, re-armed on every sync. Scheduled only when its copy is
    // guaranteed true at delivery: today (no capture yet) or, after a
    // captured day, tomorrow — a streak that survives tonight is still
    // alive tomorrow. Past 7:30 PM with no capture, nothing is scheduled;
    // tomorrow's sync re-evaluates instead of risking a false claim.
    const todayMs = atLocalMinutes(context.nowMs, STREAK_DEFENSE_MINUTES);
    const timestampMs = context.practicedToday
      ? atLocalMinutes(addDays(context.nowMs, 1), STREAK_DEFENSE_MINUTES)
      : todayMs >= context.nowMs + MIN_LEAD_MS
        ? todayMs
        : null;
    if (timestampMs !== null) {
      const copy = streakDefenseCopy(timestampMs, {
        streakDays: context.streakDays,
        shieldsAvailable: context.shieldsAvailable ?? 0,
        milestoneEve: context.milestoneEve ?? null,
      });
      plan.push({
        id: 'ps.reminder.streak',
        title: copy.title,
        body: copy.body,
        timestampMs,
        repeat: null,
        screen: 'Home',
      });
    }
  }

  if (prefs.weeklyRecap && context.hasAnyHistory) {
    const timestampMs = nextWeeklyOccurrence(
      context.nowMs,
      WEEKLY_RECAP_WEEKDAY,
      WEEKLY_RECAP_MINUTES,
    );
    const copy = weeklyRecapCopy(timestampMs);
    plan.push({
      id: 'ps.reminder.weekly',
      title: copy.title,
      body: copy.body,
      timestampMs,
      repeat: 'weekly',
      screen: 'Performance',
    });
  }

  if (prefs.comeback) {
    COMEBACK_RUNG_DAYS.forEach((days, index) => {
      const copy = COMEBACK_COPY[index];
      if (!copy) return;
      plan.push({
        id: `ps.comeback.${index + 1}` as PlannedNotification['id'],
        title: copy.title,
        body: copy.body,
        timestampMs: atLocalMinutes(
          addDays(context.nowMs, days),
          COMEBACK_MINUTES,
        ),
        repeat: null,
        screen: 'Home',
      });
    });
  }

  return plan;
}
