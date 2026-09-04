/**
 * Structural audit probe (mobile-settings-account, pass 1).
 *
 * plan.ts promises "All math is LOCAL time — reminders belong to the
 * player's clock" and the Notifications screen states the exact wall-clock
 * times ("7:30 PM on days an active streak has no capture yet", "Sundays at
 * 6:00 PM"). `atLocalMinutes` computes local midnight and ADDS
 * `minutes * 60_000` ms, which is only a wall-clock time when the day is
 * exactly 24 hours long. On a DST transition day it is off by one hour.
 *
 * Both US transitions fall on a Sunday — the weekly recap's day.
 *
 * Run with the process zone pinned (jest workers cannot change it after
 * start):  TZ=America/Los_Angeles npx jest --ci __tests__/audit/auditNotificationPlanDst.test.ts
 * The first test fails loudly (not skips) when the zone is anything else.
 */

import { buildNotificationPlan } from '../../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

const prefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  enabled: true,
  practiceReminder: true,
  practiceReminderMinutes: 17 * 60 + 30,
  streakDefense: true,
  weeklyRecap: true,
  comeback: true,
};

function wallClock(ms: number): string {
  const d = new Date(ms);
  return `${d.getDay()}:${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes(),
  ).padStart(2, '0')}`;
}

function planAt(nowMs: number) {
  const plan = buildNotificationPlan(prefs, {
    nowMs,
    streakDays: 3,
    practicedToday: false,
    hasAnyHistory: true,
  });
  const byId = new Map(plan.map(item => [item.id, item.timestampMs]));
  return {
    practice: byId.get('ps.reminder.practice')!,
    streak: byId.get('ps.reminder.streak')!,
    weekly: byId.get('ps.reminder.weekly')!,
    comeback1: byId.get('ps.comeback.1')!,
  };
}

describe('audit: notification plan on DST transition days (America/Los_Angeles)', () => {
  it('pins the host time zone the probe relies on', () => {
    // Sanity: Jan is PST (-480), Jul is PDT (-420).
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(480);
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(420);
  });

  it('spring forward (2026-03-08): every reminder keeps its wall-clock time', () => {
    // Sunday 2026-03-08 10:00 PDT — after the 2 AM skip, before any reminder.
    const now = new Date(2026, 2, 8, 10, 0, 0, 0).getTime();
    const { practice, streak, weekly } = planAt(now);
    // Sunday (0) at the configured wall-clock times.
    expect(wallClock(practice)).toBe('0:17:30');
    expect(wallClock(streak)).toBe('0:19:30');
    expect(wallClock(weekly)).toBe('0:18:00');
  });

  it('fall back (2026-11-01): every reminder keeps its wall-clock time', () => {
    // Sunday 2026-11-01 10:00 PST — after the 1 AM repeat.
    const now = new Date(2026, 10, 1, 10, 0, 0, 0).getTime();
    const { practice, streak, weekly } = planAt(now);
    expect(wallClock(practice)).toBe('0:17:30');
    expect(wallClock(streak)).toBe('0:19:30');
    expect(wallClock(weekly)).toBe('0:18:00');
  });

  it('planning on Saturday evening for a DST Sunday lands on the stated wall-clock time', () => {
    // Saturday 2026-03-07 20:00 PST: the practice nudge rolls to Sunday.
    const now = new Date(2026, 2, 7, 20, 0, 0, 0).getTime();
    const { practice, weekly } = planAt(now);
    expect(wallClock(practice)).toBe('0:17:30');
    expect(wallClock(weekly)).toBe('0:18:00');
  });

  it('comeback rungs that cross a DST boundary land at 6:30 PM local', () => {
    // Thursday 2026-03-05 09:00 PST: rung 1 (3 days) is Sunday 03-08.
    const now = new Date(2026, 2, 5, 9, 0, 0, 0).getTime();
    const { comeback1 } = planAt(now);
    expect(wallClock(comeback1)).toBe('0:18:30');
  });

  it('control: a non-DST day is exact (the arithmetic is only wrong across a transition)', () => {
    const now = new Date(2026, 5, 10, 10, 0, 0, 0).getTime(); // Wed 06-10 PDT
    const { practice, streak } = planAt(now);
    expect(wallClock(practice)).toBe('3:17:30');
    expect(wallClock(streak)).toBe('3:19:30');
  });
});
