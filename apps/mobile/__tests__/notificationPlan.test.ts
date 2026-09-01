import { buildNotificationPlan } from '../src/notifications/plan';
import type { NotificationPlanContext } from '../src/notifications/plan';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  formatReminderMinutes,
  parseNotificationPrefs,
  type NotificationPrefs,
} from '../src/notifications/types';

/**
 * The reminder planner is pure local-time math; these tests pin its honesty
 * rules: nothing when the master is off, streak copy only when true at
 * delivery, and an inactivity ladder that is always strictly in the future.
 */

const allOn: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  enabled: true,
};

// Tuesday 2026-08-25 in the device's local timezone.
const tuesdayMorning = new Date(2026, 7, 25, 10, 0, 0).getTime();

function context(
  overrides: Partial<NotificationPlanContext> = {},
): NotificationPlanContext {
  return {
    nowMs: tuesdayMorning,
    streakDays: 0,
    practicedToday: false,
    hasAnyHistory: false,
    ...overrides,
  };
}

function localParts(timestampMs: number) {
  const date = new Date(timestampMs);
  return {
    day: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    dayOfMonth: date.getDate(),
  };
}

describe('buildNotificationPlan', () => {
  it('plans nothing while the master switch is off', () => {
    expect(
      buildNotificationPlan(DEFAULT_NOTIFICATION_PREFS, context()),
    ).toEqual([]);
    expect(
      buildNotificationPlan(
        { ...DEFAULT_NOTIFICATION_PREFS, enabled: false },
        context({ streakDays: 9, practicedToday: false, hasAnyHistory: true }),
      ),
    ).toEqual([]);
  });

  it('schedules the daily practice nudge for today when the time is ahead', () => {
    const plan = buildNotificationPlan(allOn, context());
    const practice = plan.find(item => item.id === 'ps.reminder.practice');
    expect(practice).toBeDefined();
    expect(practice!.repeat).toBe('daily');
    const at = localParts(practice!.timestampMs);
    expect(at.hour).toBe(17);
    expect(at.minute).toBe(30);
    expect(at.dayOfMonth).toBe(25);
  });

  it('rolls a passed practice time to tomorrow', () => {
    const evening = new Date(2026, 7, 25, 18, 0, 0).getTime();
    const plan = buildNotificationPlan(allOn, context({ nowMs: evening }));
    const practice = plan.find(item => item.id === 'ps.reminder.practice')!;
    expect(localParts(practice.timestampMs).dayOfMonth).toBe(26);
  });

  it('respects the minimum lead: a time due within 90s rolls forward', () => {
    const almost = new Date(2026, 7, 25, 17, 29, 30).getTime();
    const plan = buildNotificationPlan(allOn, context({ nowMs: almost }));
    const practice = plan.find(item => item.id === 'ps.reminder.practice')!;
    expect(localParts(practice.timestampMs).dayOfMonth).toBe(26);
  });

  it('never plans streak defense without an active streak', () => {
    const plan = buildNotificationPlan(allOn, context({ streakDays: 0 }));
    expect(plan.find(item => item.id === 'ps.reminder.streak')).toBeUndefined();
  });

  it('defends an unpracticed day the same evening', () => {
    const plan = buildNotificationPlan(
      allOn,
      context({ streakDays: 3, practicedToday: false }),
    );
    const streak = plan.find(item => item.id === 'ps.reminder.streak')!;
    expect(streak.repeat).toBeNull();
    const at = localParts(streak.timestampMs);
    expect(at.dayOfMonth).toBe(25);
    expect(at.hour).toBe(19);
    expect(at.minute).toBe(30);
  });

  it('moves the defense to tomorrow after a captured day', () => {
    const plan = buildNotificationPlan(
      allOn,
      context({ streakDays: 3, practicedToday: true }),
    );
    const streak = plan.find(item => item.id === 'ps.reminder.streak')!;
    expect(localParts(streak.timestampMs).dayOfMonth).toBe(26);
  });

  it('drops the defense late at night instead of risking a false claim', () => {
    const lateNight = new Date(2026, 7, 25, 21, 0, 0).getTime();
    const plan = buildNotificationPlan(
      allOn,
      context({ nowMs: lateNight, streakDays: 3, practicedToday: false }),
    );
    expect(plan.find(item => item.id === 'ps.reminder.streak')).toBeUndefined();
  });

  it('sends the weekly recap on Sunday 6pm only once history exists', () => {
    expect(
      buildNotificationPlan(allOn, context({ hasAnyHistory: false })).find(
        item => item.id === 'ps.reminder.weekly',
      ),
    ).toBeUndefined();
    const plan = buildNotificationPlan(allOn, context({ hasAnyHistory: true }));
    const weekly = plan.find(item => item.id === 'ps.reminder.weekly')!;
    expect(weekly.repeat).toBe('weekly');
    expect(weekly.screen).toBe('Performance');
    const at = localParts(weekly.timestampMs);
    expect(at.day).toBe(0);
    expect(at.hour).toBe(18);
    expect(at.dayOfMonth).toBe(30);
  });

  it('rolls a passed Sunday slot a full week forward', () => {
    const sundayEvening = new Date(2026, 7, 30, 19, 0, 0).getTime();
    const plan = buildNotificationPlan(
      allOn,
      context({ nowMs: sundayEvening, hasAnyHistory: true }),
    );
    const weekly = plan.find(item => item.id === 'ps.reminder.weekly')!;
    const at = localParts(weekly.timestampMs);
    expect(at.day).toBe(0);
    expect(at.dayOfMonth).toBe(6);
  });

  it('arms the comeback ladder at 3, 7, and 14 days ahead', () => {
    const plan = buildNotificationPlan(allOn, context());
    const rungs = plan.filter(item => item.id.startsWith('ps.comeback.'));
    expect(rungs.map(rung => localParts(rung.timestampMs).dayOfMonth)).toEqual([
      28, 1, 8,
    ]);
    for (const rung of rungs) {
      expect(rung.repeat).toBeNull();
      expect(localParts(rung.timestampMs).hour).toBe(18);
      expect(localParts(rung.timestampMs).minute).toBe(30);
      expect(rung.timestampMs).toBeGreaterThan(tuesdayMorning);
    }
  });

  it('omits disabled types and keeps ids unique under the app prefix', () => {
    const someOff = buildNotificationPlan(
      { ...allOn, weeklyRecap: false, comeback: false },
      context({ streakDays: 1, hasAnyHistory: true }),
    );
    expect(someOff.map(item => item.id).sort()).toEqual([
      'ps.reminder.practice',
      'ps.reminder.streak',
    ]);
    const everything = buildNotificationPlan(
      allOn,
      context({ streakDays: 1, hasAnyHistory: true }),
    );
    const ids = everything.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith(NOTIFICATION_ID_PREFIX)).toBe(true);
    }
    for (const item of everything) {
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.body.length).toBeGreaterThan(0);
    }
  });
});

describe('parseNotificationPrefs', () => {
  it('falls back to defaults for null, garbage, and wrong shapes', () => {
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs('not json')).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
    expect(parseNotificationPrefs('[1,2]')).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs('42')).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it('keeps valid fields and repairs invalid ones individually', () => {
    const parsed = parseNotificationPrefs(
      JSON.stringify({
        enabled: true,
        practiceReminder: false,
        practiceReminderMinutes: 99999,
        streakDefense: 'yes',
        weeklyRecap: true,
        comeback: false,
        promptDismissed: true,
      }),
    );
    expect(parsed.enabled).toBe(true);
    expect(parsed.practiceReminder).toBe(false);
    expect(parsed.practiceReminderMinutes).toBe(
      DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
    );
    expect(parsed.streakDefense).toBe(DEFAULT_NOTIFICATION_PREFS.streakDefense);
    expect(parsed.weeklyRecap).toBe(true);
    expect(parsed.comeback).toBe(false);
    expect(parsed.promptDismissed).toBe(true);
  });
});

describe('formatReminderMinutes', () => {
  it('formats morning, midday, evening, and midnight', () => {
    expect(formatReminderMinutes(0)).toBe('12:00 AM');
    expect(formatReminderMinutes(7 * 60 + 30)).toBe('7:30 AM');
    expect(formatReminderMinutes(12 * 60)).toBe('12:00 PM');
    expect(formatReminderMinutes(17 * 60 + 30)).toBe('5:30 PM');
    expect(formatReminderMinutes(23 * 60 + 45)).toBe('11:45 PM');
  });
});
